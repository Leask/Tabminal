FROM node:latest

WORKDIR /app

# Copy package files first for caching
COPY package.json package-lock.json ./

# Install dependencies
# Using 'npm install -g .' later to mimic npx/global install behavior
RUN npm install

# Install cloudflared
RUN curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb && \
    dpkg -i cloudflared.deb && \
    rm cloudflared.deb

# Copy source code
COPY . .

# Install the project globally so 'tabminal' command is available
RUN npm install -g .

# Expose the default port
EXPOSE 9846

# Set the entrypoint to the Tabminal CLI
ENTRYPOINT ["tabminal"]

# Default command (can be overridden)
CMD ["--help"]
