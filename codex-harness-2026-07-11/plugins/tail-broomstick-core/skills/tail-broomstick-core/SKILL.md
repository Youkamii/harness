---
name: tail-broomstick-core
description: Register or replace a secret through Tail Broomstick's protected local entry without placing the value in model-visible chat. Use when a user wants to add or update a credential safely.
---

# Tail Broomstick Core

Never ask the user to paste a token, password, private key, cookie, or other
secret into Codex. Only a public alias belongs in chat. Tail Broomstick collects
the value in a separate protected Windows window.

For the released credential slot, tell the user to submit this exact command as
its own prompt:

```text
tb: put alias:github-work
```

Do not append a value, flag, comment, or second line. Do not invent another
alias. The synchronous hook handles the reserved command locally before model
delivery.

If a secret was already pasted into chat, do not repeat it. Tell the user to
rotate it at its provider and register the replacement through the protected
flow. Do not claim completion unless that flow reported success. An uncertain
result must not be retried blindly.
