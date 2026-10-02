FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=latest

# Tools Claude Code commonly shells out to
RUN apt-get update && apt-get install -y --no-install-recommends \
  git curl ca-certificates ripgrep jq less procps openssh-client \
  && rm -rf /var/lib/apt/lists/*

# Document tooling: convert, read and generate Word/Excel/PowerPoint/PDF/images
RUN apt-get update && apt-get install -y --no-install-recommends \
  pandoc weasyprint \
  libreoffice-writer libreoffice-calc libreoffice-impress \
  poppler-utils qpdf ghostscript \
  imagemagick tesseract-ocr tesseract-ocr-ita ocrmypdf \
  python3 python3-venv python3-pip \
  zip unzip file fonts-liberation fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

# Python libraries for editing office files and PDFs, in a venv that is first on PATH
RUN python3 -m venv /opt/pytools \
  && /opt/pytools/bin/pip install --no-cache-dir \
  python-docx openpyxl python-pptx pypdf pdfplumber pymupdf reportlab
ENV PATH=/opt/pytools/bin:$PATH

# Global npm installs go to a dir the non-root user owns (so in-app auto-update works)
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=$PATH:/usr/local/share/npm-global/bin
RUN mkdir -p /usr/local/share/npm-global && chown -R node:node /usr/local/share/npm-global

# Keep all Claude config/credentials in one dir so a single volume persists it
ENV CLAUDE_CONFIG_DIR=/home/node/.claude
RUN mkdir -p /home/node/.claude /workspace /agent-data /agents-extra \
  && chown -R node:node /home/node/.claude /workspace /agent-data

# Run as non-root (--dangerously-skip-permissions refuses to run as root)
USER node
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# HTTP adapter used by the `api` compose service
COPY server.mjs /opt/claude-api/server.mjs
COPY src /opt/claude-api/src
# Agents the API can run by name (`"agent"` in a request); read-only for Claude, which runs as `node`
COPY agents /opt/claude-api/agents

WORKDIR /workspace
CMD ["claude"]
