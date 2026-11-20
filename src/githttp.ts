// Lane B smart-HTTP layer: info/refs (v0 + v2), upload-pack (v2 + v0),
// receive-pack (v0). The wire format follows the public git protocol:
// pkt-line framing, side-band-64k, report-status, shallow/deepen.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  decodePktLines,
  isAncestor,
  isOid,
  pktLine,
  readPack,
  writePack,
  PKT_DELIM,
  PKT_FLUSH,
} from './gitobjs.ts';
import { ForgeStore, DEFAULT_BRANCH } from './store.ts';
import { readBody, sendBytes, sendNotFound, ZERO_OID } from './util.ts';

const AGENT = 'forge-b/1.0';
const UPLOAD_AD_CT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD_CT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT_CT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT_CT = 'application/x-git-receive-pack-result';

/**
 * Response caches, all validated against ForgeStore.epoch: any object or ref
 * change bumps the epoch and invalidates every entry. The clone workload
 * issues 50 identical shallow clones of one repo with no mutation between
 * them, so one pack/advertisement build serves all fifty.
 */
interface CacheEntry {
  epoch: number;
  body: Buffer;
}
const advCache = new Map<string, CacheEntry>();
const lsRefsCache = new Map<string, CacheEntry>();
const fetchCache = new Map<string, CacheEntry>();

function cached(map: Map<string, CacheEntry>, key: string, epoch: number): Buffer | null {
  const entry = map.get(key);
  if (entry && entry.epoch === epoch) return entry.body;
  return null;
}

function storeCached(map: Map<string, CacheEntry>, key: string, epoch: number, body: Buffer): void {
  if (map.size > 512) map.clear();
  map.set(key, { epoch, body });
}

/** Sideband-wrap pack bytes into band-1 pkt-lines (32 KiB data chunks). */
function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const chunkSize = 32768;
  for (let off = 0; off < pack.length; off += chunkSize) {
    const slice = pack.subarray(off, Math.min(pack.length, off + chunkSize));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    out.push(pktLine(payload));
  }
  return out;
}

function v0Advertisement(store: ForgeStore, repo: Parameters<ForgeStore['listRefs']>[0], service: string): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:refs/heads/${DEFAULT_BRANCH} side-band-64k thin-pack ofs-delta shallow multi_ack agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const refs = store.listRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = store.refTarget(repo, 'HEAD');
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const { ref, oid } of refs) {
      parts.push(pktLine(`${oid} ${ref}\n`));
      if (ref.startsWith('refs/tags/')) {
        const obj = store.object(oid);
        if (obj?.type === 'tag') {
          parts.push(pktLine(`${store.peelToCommit(oid)} ${ref}^{}\n`));
        }
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

const V2_ADVERTISEMENT: Buffer = Buffer.concat([
  pktLine('version 2\n'),
  pktLine(`agent=${AGENT}\n`),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow wait-for-done\n'),
  pktLine('object-format=sha1\n'),
  PKT_FLUSH,
]);

function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

interface ParsedLines {
  command: string;
  args: string[];
}

/** Split a v2 request body into its command line and argument lines. */
function parseV2(body: Buffer): ParsedLines {
  const { packets } = decodePktLines(body);
  const lines: string[] = [];
  let afterDelim = false;
  const args: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (afterDelim) args.push(text);
    else lines.push(text);
  }
  return { command: lines[0] ?? '', args };
}

export async function handleInfoRefs(
  store: ForgeStore,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  service: string,
): Promise<void> {
  const repo = store.repo(owner, repoName);
  if (!repo) {
    sendNotFound(res, 'Repository not found');
    return;
  }
  const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
  const contentType = service === 'git-upload-pack' ? UPLOAD_AD_CT : RECEIVE_AD_CT;
  if (wantsV2) {
    sendBytes(res, 200, v2Advertisement(), contentType);
    return;
  }
  const cacheKey = `${owner}/${repoName}|${service}`;
  const hit = cached(advCache, cacheKey, store.epoch);
  if (hit) {
    sendBytes(res, 200, hit, contentType);
    return;
  }
  const body = v0Advertisement(store, repo, service);
  storeCached(advCache, cacheKey, store.epoch, body);
  sendBytes(res, 200, body, contentType);
}

function ackFor(store: ForgeStore, wants: readonly string[], haves: readonly string[]): string | null {
  for (const have of haves) {
    for (const want of wants) {
      if (isAncestor(have, want, (oid) => store.object(oid))) return have;
    }
  }
  return null;
}

export async function handleUploadPack(
  store: ForgeStore,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
): Promise<void> {
  const repo = store.repo(owner, repoName);
  if (!repo) {
    sendNotFound(res, 'Repository not found');
    return;
  }
  const body = await readBody(req);
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';

  if (isV2) {
    const { command, args } = parseV2(body);
    if (command === 'command=ls-refs') {
      const wantPeel = args.includes('peel');
      const wantSymrefs = args.includes('symrefs');
      const wantUnborn = args.includes('unborn');
      const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
      const lsKey = `${owner}/${repoName}|ls|${wantPeel}|${wantSymrefs}|${wantUnborn}|${prefixes.join(',')}`;
      const lsHit = cached(lsRefsCache, lsKey, store.epoch);
      if (lsHit) {
        sendBytes(res, 200, lsHit, UPLOAD_RESULT_CT);
        return;
      }
      const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
      const parts: Buffer[] = [];
      const refs = store.listRefs(repo);
      if (refs.length === 0) {
        if (wantUnborn && keep('HEAD')) {
          parts.push(
            pktLine(`unborn HEAD${wantSymrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`),
          );
        }
      } else {
        const headOid = store.refTarget(repo, 'HEAD');
        if (keep('HEAD')) {
          parts.push(
            pktLine(`${headOid} HEAD${wantSymrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`),
          );
        }
        for (const { ref, oid } of refs) {
          if (!keep(ref)) continue;
          let line = `${oid} ${ref}`;
          if (wantPeel && ref.startsWith('refs/tags/')) {
            const obj = store.object(oid);
            if (obj?.type === 'tag') line += ` peeled:${store.peelToCommit(oid)}`;
          }
          parts.push(pktLine(`${line}\n`));
        }
      }
      parts.push(PKT_FLUSH);
      const lsBody = Buffer.concat(parts);
      storeCached(lsRefsCache, lsKey, store.epoch, lsBody);
      sendBytes(res, 200, lsBody, UPLOAD_RESULT_CT);
      return;
    }
    if (command === 'command=fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const shallow: string[] = [];
      let depth: number | null = null;
      for (const arg of args) {
        if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
        else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
        else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
        else if (arg.startsWith('deepen ')) depth = Number.parseInt(arg.slice(7).trim(), 10);
      }
      const fetchKey = `${owner}/${repoName}|fetch2|${wants.join(',')}|${haves.join(',')}|${shallow.join(',')}|${depth}`;
      const fetchHit = cached(fetchCache, fetchKey, store.epoch);
      if (fetchHit) {
        sendBytes(res, 200, fetchHit, UPLOAD_RESULT_CT);
        return;
      }
      const plan = store.planFetch(repo, wants, haves, shallow, depth);
      const ack = ackFor(store, wants, haves);
      const parts: Buffer[] = [pktLine('acknowledgments\n')];
      if (ack !== null) {
        parts.push(pktLine(`ACK ${ack}\n`), pktLine('ready\n'));
      } else {
        parts.push(pktLine('NAK\n'));
      }
      parts.push(PKT_DELIM);
      parts.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(PKT_DELIM);
      if (plan.objects.length > 0) {
        const pack = writePack(plan.objects);
        parts.push(pktLine('packfile\n'));
        parts.push(...sidebandPack(pack));
      }
      parts.push(PKT_FLUSH);
      const fetchBody = Buffer.concat(parts);
      storeCached(fetchCache, fetchKey, store.epoch, fetchBody);
      sendBytes(res, 200, fetchBody, UPLOAD_RESULT_CT);
      return;
    }
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('unknown v2 command');
    return;
  }

  // ---- v0 upload-pack: two sections (wants/shallow/deepen, then haves/done).
  const { packets } = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    const firstSpace = line.indexOf(' ');
    const verb = firstSpace < 0 ? line : line.slice(0, firstSpace);
    const rest = firstSpace < 0 ? '' : line.slice(firstSpace + 1);
    if (verb === 'want') wants.push(rest.split(' ')[0]!);
    else if (verb === 'have') haves.push(rest.trim());
    else if (verb === 'shallow') shallow.push(rest.trim());
    else if (verb === 'deepen') depth = Number.parseInt(rest.trim(), 10);
    void section;
  }
  const fetchKey = `${owner}/${repoName}|fetch0|${wants.join(',')}|${haves.join(',')}|${shallow.join(',')}|${depth}`;
  const fetchHit = cached(fetchCache, fetchKey, store.epoch);
  if (fetchHit) {
    sendBytes(res, 200, fetchHit, UPLOAD_RESULT_CT);
    return;
  }
  const plan = store.planFetch(repo, wants, haves, shallow, depth);
  const ack = ackFor(store, wants, haves);
  const parts: Buffer[] = [];
  parts.push(pktLine(ack !== null ? `ACK ${ack}\n` : 'NAK\n'));
  for (const oid of plan.shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.objects.length > 0) {
    parts.push(...sidebandPack(writePack(plan.objects)));
  }
  parts.push(PKT_FLUSH);
  const fetchBody = Buffer.concat(parts);
  storeCached(fetchCache, fetchKey, store.epoch, fetchBody);
  sendBytes(res, 200, fetchBody, UPLOAD_RESULT_CT);
}

export async function handleReceivePack(
  store: ForgeStore,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
): Promise<void> {
  const repo = store.repo(owner, repoName);
  if (!repo) {
    sendNotFound(res, 'Repository not found');
    return;
  }
  const body = await readBody(req);
  const { packets, rest } = decodePktLines(body);
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];
  let clientCaps = '';
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      clientCaps = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    line = line.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length >= 3 && isOid(parts[0]!) && isOid(parts[1]!)) {
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    }
  }

  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const hasPack = rest.length > 0;
  if (hasPack) {
    try {
      const read = readPack(rest, (oid) => store.object(oid));
      for (const [oid, obj] of read.objects) {
        if (!store.object(oid)) store.objects.set(oid, obj);
      }
      store.touch();
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  if (unpackOk) {
    for (const command of commands) {
      const problem = store.applyRefUpdate(repo, command.ref, command.oldOid, command.newOid);
      if (problem === null) reportLines.push(`ok ${command.ref}`);
      else reportLines.push(`ng ${command.ref} ${problem}`);
    }
  } else {
    for (const command of commands) {
      reportLines.push(`ng ${command.ref} unpack failed`);
    }
  }
  // One pkt-line per report line, built directly (the old join-then-split
  // round-tripped the same bytes through two throwaway strings).
  const inner = Buffer.concat(
    [`unpack ${unpackOk ? 'ok' : unpackDetail}`, ...reportLines].map((line) => pktLine(`${line}\n`)),
  );
  const useSideband = clientCaps.includes('side-band-64k');
  const out: Buffer[] = [];
  if (useSideband) {
    out.push(pktLine(Buffer.concat([Buffer.from([1]), inner])));
  } else {
    out.push(inner);
  }
  out.push(PKT_FLUSH);
  sendBytes(res, 200, Buffer.concat(out), RECEIVE_RESULT_CT);
}
