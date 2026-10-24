FROM node:20.11-slim
# TODO(review): take the Node image as a build ARG (NODE_IMAGE) so it can be bumped without a code change.
WORKDIR /app
COPY . .
CMD ["node", "scripts/serve.js"]
