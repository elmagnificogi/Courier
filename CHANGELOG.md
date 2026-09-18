# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Official WeCom (企业微信), WeChat Official Account, and QQ bot adapters for the same command surface as Telegram/Feishu (`/help`, `/mode`, `/choose`, prompt relay).
- IM notification hub so CDP preflight alerts fan out to every enabled adapter, not only Telegram.
- `/choose` support on the shared CommandRouter used by non-Telegram adapters.

### Changed
- Renamed the project from Gantry to Courier.
- `TELEGRAM_BOT_TOKEN` is optional so a machine can run WeCom/WeChat/QQ/HTTP only.
- Re-licensed Gantry from AGPL-3.0 to MIT.
- Standardized attribution: Copyright holder is Grasp Visual LLC, created by Alan Perez.
- Removed landing-page and enterprise marketing references from repository docs/metadata.

## [0.1.0] - 2026-03-12

### Added
- Initial open-source preview of Gantry core bridge for Cursor, Windsurf, and VS Code automation.
- Multi-platform adapter support (Telegram primary, plus Discord, Email, Feishu, and HTTP API paths).
- Release gate workflow with lint, typecheck, build, smoke checks, and secret scanning.
- Smoke test coverage for prompt guardrails and persisted chat-state behavior.

### Security
- Inbound prompt exfiltration blocking and outbound secret redaction guardrails.
- Repository-level secret scanning script for tracked files.

### Known Limitations
- This is a `v0.x` preview release; interfaces and behavior may change before `v1.0.0`.
- IDE automation reliability varies by product/version and may require selector updates.
- Some platform capabilities are best-effort and intentionally documented with support labels.
