# End-to-end test image for "Vertical Tabs with Previews".
#
# The tag MUST match the @playwright/test version in tests/package.json exactly
# (image v1.62.1-noble ships Chromium 151.0.7922.34 / Chrome for Testing).
# Nothing in this project is ever installed on the WSL2 host.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /opt/e2e

# The build context is the repository root (see tests/docker-compose.yml), so the
# paths below are repo-relative. The lockfile glob is optional: the first build in
# a fresh clone has no lockfile and falls back to `npm install`.
COPY tests/package.json tests/package-lock.json* ./

RUN if [ -f package-lock.json ]; then \
      npm ci --no-audit --no-fund; \
    else \
      npm install --no-audit --no-fund; \
    fi \
 && chmod -R a+rX /opt/e2e

ENV NODE_PATH=/opt/e2e/node_modules \
    PATH=/opt/e2e/node_modules/.bin:$PATH \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# The repository is bind-mounted at /work by docker-compose.
WORKDIR /work/tests
