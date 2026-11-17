# Deployment

A push to `main` runs CI on GitHub. Dexter independently checks that the exact current `main` commit passed the `CI` workflow for a push before building and deploying it. Pull requests and failed or stale runs cannot trigger a deployment. No deployment credentials are stored in GitHub Actions.

The live configuration, session signing key, push keys, PostgreSQL database and Cloudflare tunnel remain on Dexter. Deployment operations and onboarding instructions are maintained on Dexter in `/etc/hackerpod-deploy/README.md`.

The service worker is served with revalidation. Existing installed apps may need to be closed and reopened to activate an update; icon refresh timing is controlled by the operating system.
