import { nix, type NixExpr } from "./index.js";
import type { NixList, NixPath, NixString } from "@tsix/ir";

const stringExpression: NixExpr<NixString> = nix.str`hello`;
const pathExpression: NixExpr<NixPath> = nix.path.preserve("./hello");
const listExpression: NixExpr<NixList> = nix.list([stringExpression]);

// @ts-expect-error A path is not a string.
const badString: NixExpr<NixString> = pathExpression;
// @ts-expect-error A list is not a path.
const badPath: NixExpr<NixPath> = listExpression;
// @ts-expect-error Arbitrary objects cannot be interpolated into a path.
const badInterpolation = nix.path.preserve`./${{ value: "unsafe" }}`;

void badString;
void badPath;
void badInterpolation;
