# Verify NPM Token

The workflow [verify-npm-token.yml](verify-npm-token.yml) checks that the repo secret `NPM_TOKEN` can authenticate with npm.

**Run it:** Actions → **Verify NPM Token** → **Run workflow**.

Ensure **NPM_TOKEN** is set in Settings → Secrets and variables → Actions (value = your npm access token from https://www.npmjs.com/settings/~/tokens).
