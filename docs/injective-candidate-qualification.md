# Injective combined CLI candidate evidence

## Current source follow-up

The later `spot readiness`, `spot order` and `spot cancel` additions reuse the
existing authenticated command/approval/recovery path. Their authored plugin and
actual-CLI fixture cases still need ordinary CI and an exact-source candidate
build. The historical binaries below do not contain or qualify these additions.
No version, release, tenant pin or promotion is changed. Spot is separately
backend-gated and does not block Phase3–6 acceptance.

## Historical candidate

Candidate source: `998aeddc1ecbf122831078fed65b7e0bc8b18f3e` on PURR #103.
This is the combined native perpetual management/RFQ CLI source, not a released
minimum version or a tenant installation pin.

- Normal [check run40665219369](https://github.com/Pieverse-Eng/purr-cli/actions/runs/40665219369) succeeded.
- Existing [Release workflow run40669935166](https://github.com/Pieverse-Eng/purr-cli/actions/runs/40669935166), dispatched with `skip_release=true`, succeeded.
- The `release` job is **skipped**. No tag or GitHub Release was published.
- Actual standalone binary checks succeeded on Linux x64 and macOS ARM64.
  Those checks use the CLI's disposable HTTP fixtures, including explicit
  execution, policy202 and original-request recovery. They do not sign, fund or
  trade on-chain. The other targets only prove cross-compilation.

| Artifact | GitHub artifact ID | Evidence |
| --- | --- | --- |
| purr-linux-x64 | 12807418182 | Built; native binary checks passed |
| purr-linux-arm64 | 12806689711 | Built; no native execution check |
| purr-darwin-arm64 | 12808156503 | Built; native binary checks passed |
| purr-darwin-x64 | 12808051844 | Built; no native execution check |
| purr-windows-x64.exe | 12807517799 | Built; no native execution check |

These short-lived artifacts expire on 2026-10-31. GitHub's API reported the
following **artifact ZIP digests**, not standalone binary checksums:

```text
purr-linux-x64       sha256:40457e34f780ac9ad1001456e6992b831baf99102270b7e257021945c990bc6d
purr-linux-arm64     sha256:9d46485861fe04395db20a513a4997b08457717d7b63a4ce60469a13736e1862
purr-darwin-arm64    sha256:8ef7d81febbd2f8b70efd4bd6d94429a249c394487ba38f2f6bf136a0a22e4c7
purr-darwin-x64      sha256:a33ccf2a2b657008b98d2470b02350586a6bba65cecaab57ab43dad392d4a22d
purr-windows-x64.exe sha256:484578dac4e02179bed8590b06f0acf96d6dc221bd33a02b05beaedad0ffcc0f
```

Never turn these ZIP digests into future release checksums or installation
pins. A formal release must use its own actual produced binaries and checksums.
Backend capabilities, finite RFQ grant compatibility, real INJ/fees and funded
book↔RFQ position/protection behavior still require separate acceptance. Skills
and Hermes runtime pins/promotion remain pending; no tenant was changed.
