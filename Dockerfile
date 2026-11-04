
# Use the official Node.js 26 image.
FROM node:26-bookworm-slim

# Set the application directory.
WORKDIR /app

# Copy dependency configuration.
COPY package*.json ./

# Install production dependencies.
RUN npm install --omit=dev && npm cache clean --force

# Copy the application source code.
COPY --chown=node:node . .

# Prepare persistent database directory.
RUN mkdir -p /app/storage \
    && chown -R node:node /app/storage

# Run the application as a non-root user.
USER node

# Expose the website port.
EXPOSE 3000

# Start the Node.js application.
CMD ["npm", "start"]