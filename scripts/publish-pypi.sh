#!/bin/bash
set -e

echo "Publishing utopia-runtime to PyPI..."
cd "$(dirname "$0")/../python"

# Clean old builds
rm -rf dist/ build/ *.egg-info

# Build
python3 -m pip install --upgrade build twine 2>/dev/null
python3 -m build

# Upload
python3 -m twine upload dist/*

echo "Done! Published utopia-runtime@$(python3 -c "import tomllib; print(tomllib.load(open('pyproject.toml','rb'))['project']['version'])")"
