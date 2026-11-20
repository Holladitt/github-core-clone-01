# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Holladitt/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Holladitt/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node.js process: git smart HTTP (upload-pack v2, receive-pack), a GitHub REST v3 API, GraphQL, and MCP tools, all served from its own in-memory store with byte-for-byte deterministic state export. Built for make.fun's github-core-clone-01 bounty.

## Run it

```sh
node main.ts
```

The forge binds an ephemeral port of its own and registers it with the suite; it never binds 8080.

---

Entered on [make.fun](https://make.fun/?ref=t774y4rd&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards
