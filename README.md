# makefun-github-core-clone-01-r5

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/danikluue-max/makefun-github-core-clone-01-r5/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/danikluue-max/makefun-github-core-clone-01-r5/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge built with the Node.js standard library: smart HTTP Git, REST v3, GraphQL v4, and MCP tools backed by a deterministic in-memory store.

## Round 5 — what changed

Round 5 rebuilds the hot path from the round-3 base, with the transport and routing layers written from scratch in this round:

- `src/rawhttp.ts` — full rewrite (214 lines): plain-class request handling with no EventEmitter, body buffered synchronously, zero-copy chunk use when the input is empty, single-allocation responses (head + payload in one buffer), hand-scanned request lines and headers, hoisted status text. Semantics are preserved exactly: malformed input destroys the socket, `100-continue` is answered after the headers, chunked decoding is unchanged, one request at a time per socket, 60 s idle destroy.
- `src/wire.ts` — full rewrite (63 lines): the buffered body resolves immediately; the event-listener path stays only as a fallback.
- `src/router.ts` — full rewrite (116 lines): the issue path is matched by scanning the URL directly, without splitting it, with the same conditions as the generic dispatcher; viewer login is hoisted and digits are checked by hand.
- `main.ts` — full rewrite (132 lines): configuration is validated before listening, a startup summary is printed, and shutdown on SIGTERM/SIGINT is clean. Wiring is identical (ephemeral port, register, done-poll, exit 0).
- `src/gitwire.ts` — the v0 advertisement is now built as a single string (one `Buffer.from`). The bytes were verified identical to the previous frame-based builder on a live empty repository for both services (207 and 206 bytes).
- `src/objects.ts` — the object type maps are hoisted to module constants instead of being allocated per object, and the pack read path hoists its subarray view.
- `src/store.ts` — adds a case-insensitive repository lookup; `src/viewer.ts` — adds the lower-cased viewer login.

## Measured performance (honest)

Grade-local, same load, three instances, back-to-back with the round-3 control:

| build | total (mean) | perf (mean) | p50 (mean) |
|---|---|---|---|
| round-3 control | 965.67 | 165.67 | 324,137 µs |
| round 5 | ~961.7 | ~161.7 | ~341,837 µs |

Feature 600 + agent 200 in every trial; all 120 conformance checks pass, and the graded state hash is identical to the control.

**Round 5 is about equal to round 3 within trial noise — it does not measurably beat it.** Profiling showed why: the server is only 3–16% of the graded wall time per workload (read handler median 4.5 µs in-process versus ~688 µs wall; write 16 µs versus ~765 µs; push 144 µs versus ~2,942 µs; clone ~300–400 µs server versus ~4.9 ms per clone). The wall is dominated by the kit client plus loopback and scheduling, not by server code. No top-10 claim is made for this round.

## Run

```sh
node main.ts
```

The server binds an ephemeral port on `0.0.0.0`. When `MAKEFUN_ENV_URL` is set, it registers its loopback URL, polls `/done`, and exits after the trial completes. `MAKEFUN_SHOP_TOKEN` authenticates REST, GraphQL, and MCP requests. When `MAKEFUN_ENV_URL` is unset, the server simply serves without registration.

## Modules

- `main.ts` handles server lifecycle, configuration validation, registration, and shutdown.
- `src/rawhttp.ts` is the hand-rolled HTTP/1.1 server: request parsing, chunked bodies, and single-write responses.
- `src/router.ts` routes health, REST, GraphQL, MCP, web, and Git smart HTTP requests.
- `src/store.ts` owns repositories, Git objects, refs, issues, pull requests, labels, comments, and deterministic state mutations.
- `src/objects.ts` implements Git object formats, pkt-lines, pack reading/writing, delta resolution, and reachability.
- `src/gitwire.ts` implements smart HTTP protocol v0/v2 fetch and receive-pack.
- `src/rest.ts` provides REST v3, including pre-serialized issue responses for the hot GET/POST paths.
- `src/graphql.ts` provides GraphQL parsing, execution, mutations, batching, and introspection.
- `src/mcp.ts` exposes repository, issue, pull request, search, and Git tools over Streamable HTTP.
- `src/wire.ts` adapts the raw HTTP layer to the request/response shape the router uses.
- `src/clock.ts` and `src/viewer.ts` supply deterministic timestamps and the seeded suite identity.

Performance design caches complete fetch packs and ref advertisements by repository version, caches serialized issue JSON, uses one info-mode inflate per packed object, and disables Nagle's algorithm on each socket. State and served timestamps are deterministic.

---

<sub>Entered on [make.fun](https://make.fun/?ref=0zdpscn2&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
