# Stavka engineering contract

Follow [AGENTS.md](./AGENTS.md) in full, including its copy-paste Maskirovka probes and replay-before-commit rule. In particular: Effect v4 owns application code and contract-first HTTP routing, SQL lives only in Effect repository services, web surfaces import granular `@cloudflare/kumo` components and compose feature UI locally, Python uses `uv`, and development LLM traffic goes through `127.0.0.1:4141` with tier aliases rather than provider keys or concrete models.
