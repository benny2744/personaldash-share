FROM node:22-alpine

ENV NODE_ENV=production

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./
COPY lib ./lib
# Source files may carry restrictive host modes (umask 077); make them
# readable for the unprivileged runtime user.
RUN chmod -R a+rX /app

ENV PORT=3016 \
    HOST=0.0.0.0

EXPOSE 3016

# Run unprivileged. The SSH key directory is mounted read-only.
USER nobody

CMD ["node", "server.js"]
