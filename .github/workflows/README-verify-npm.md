# Verify NPM token locally (GitHub Actions via act)

The workflow [verify-npm-token.yml](verify-npm-token.yml) checks that your `NPM_TOKEN` can authenticate and (if the package exists) access the package on npm.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (required by act)
- [act](https://github.com/nektos/act): run GitHub Actions locally  
  - Windows: `choco install act-cli`  
  - macOS: `brew install act`  
  - Or: `curl https://raw.githubusercontent.com/nektos/act/master/install.sh | sudo bash`

## Run the verification

From the repo root, pass your token once:

```bash
act workflow_dispatch -s NPM_TOKEN="your-npm-token"
```

To avoid putting the token in the shell, use a secret file (do not commit it):

```bash
# Create .secrets (add to .gitignore)
echo "NPM_TOKEN=your-npm-token" > .secrets

# Run
act workflow_dispatch --secret-file .secrets
```

The job will:

1. Run `npm whoami` to confirm the token is valid.
2. Run `npm view @tanvoid0/bot-client version` to confirm access to the package (or print a message if it’s not published yet).

If both steps succeed, the token is working for use in the real CI publish job.
