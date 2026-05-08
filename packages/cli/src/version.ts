// Bumped at release time alongside packages/cli/package.json. Keeping it in
// source (instead of importing the package.json) means the constant survives
// being shipped from dist/ without dragging the whole package manifest along.
export const CLI_VERSION = "0.1.0";
