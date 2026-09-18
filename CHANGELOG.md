# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Official WeCom (企业微信), WeChat Official Account, and QQ bot adapters for the same command surface as Telegram/Feishu (`/help`, `/mode`, `/choose`, prompt relay).
- IM notification hub so CDP preflight alerts fan out to every enabled adapter, not only Telegram.
- `/choose` support on the shared CommandRouter used by non-Telegram adapters.
- QQ C2C streaming (`/v2/users/{openid}/stream_messages`) that replace-updates one bubble with growing Cursor `assistant-markdown`.
- Full-turn Composer capture: wait for `tail-status` / tool `loading` to clear and `turn-actions` to appear, then join every assistant markdown row in the pair.
- `CURSOR_RELAY_MAX_MS` (default 1 hour) for long agent turns when an IM adapter supplies `onProgress`.

### Changed
- Renamed the project from Gantry to Courier.
- `TELEGRAM_BOT_TOKEN` is optional so a machine can run WeCom/WeChat/QQ/HTTP only.
- Shared CommandRouter replies are Chinese; `/targets` lists window titles only.
- QQ group finals send custom Markdown (`msg_type=2`); C2C prefers streamed Markdown and falls back to text.
- Re-licensed Gantry from AGPL-3.0 to MIT.
- Standardized attribution: Copyright holder is Grasp Visual LLC, created by Alan Perez.
- Removed landing-page and enterprise marketing references from repository docs/metadata.

### Fixed
- Outbound redaction no longer treats ordinary window titles and workbench paths as tokens (JWT / `sk-` / assignment / bearer only).
- Multi-window Cursor on one CDP port is pinned by title/`/target n` instead of the shared `workbench.html` URL.

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
