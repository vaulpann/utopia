#!/bin/bash
set -e

echo "Publishing utopia-runtime to npm..."
cd "$(dirname "$0")/../src/runtime/js"

# Build
npm install
npm run build

# Publish (use --access public for first publish of scoped packages)
npm publish --access public

echo "Done! Published utopia-runtime@$(node -e "console.log(require('./package.json').version)")"
