#!/usr/bin/env sh
# Build the app and publish it to GitHub Pages (the gh-pages branch of origin).
# Run from app/:  npm run publish
set -e
npm test
npm run build
origin=$(git remote get-url origin)
commit=$(git rev-parse --short HEAD)
cd dist
touch .nojekyll
rm -rf .git
git init -q -b gh-pages
git add -A
git -c user.name="${GIT_AUTHOR_NAME:-Crossing}" -c user.email="${GIT_AUTHOR_EMAIL:-crossing@users.noreply.github.com}" commit -q -m "Publish $commit"
# The branch holds nothing but the latest build, so it is replaced each time.
git push -q --force "$origin" gh-pages
rm -rf .git
echo "Published $commit"
