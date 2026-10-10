@echo off
setlocal
set DOTENV_CONFIG_PATH=.env.codex
pushd %~dp0
npx tsx src/index.ts
popd
