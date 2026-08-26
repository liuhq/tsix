import {
  expr,
  isExpr,
  type DerivationRef,
  type ExprNode,
  type FlakeDefinition,
  type InputDefinition,
  type NixAttrSet,
  type NixBool,
  type NixDerivationOutput,
  type NixDerivation,
  type NixExpr,
  type NixFunction,
  type NixList,
  type NixNumber,
  type NixPath,
  type NixString,
  type NixosSystemDefinition,
  type Primitive,
  type TemplateHole,
  type TemplateParts,
} from "@tsix/ir";

export type NixValue =
  | Primitive
  | NixExpr<unknown>
  | readonly NixValue[]
  | { readonly [key: string]: NixValue };
export type StringHole = string | number | boolean | NixExpr<unknown>;
export type PathHole = string | number | NixExpr<NixString | NixNumber>;

function node(value: NixValue): ExprNode {
  if (isExpr(value)) return value.node;
  if (Array.isArray(value)) return { kind: "list", items: value.map(node) };
  if (typeof value === "object" && value !== null) {
    return {
      kind: "attrset",
      attrs: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, node(item)])),
    };
  }
  return { kind: "literal", value: value as Primitive };
}

function assertIdentifier(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_'-]*$/.test(name))
    throw new TypeError(`Invalid Nix identifier: ${name}`);
}

function template(strings: TemplateStringsArray, holes: readonly TemplateHole[]): TemplateParts {
  return { strings: [...strings], holes: [...holes] };
}

export interface PathOptions {
  readonly base?: string | URL;
}
export interface PathTag {
  (path: string, options?: PathOptions): NixExpr<NixPath>;
  from(
    root: string,
    options?: PathOptions,
  ): (strings: TemplateStringsArray, ...holes: PathHole[]) => NixExpr<NixPath>;
  preserve(path: string): NixExpr<NixPath>;
  preserve(strings: TemplateStringsArray, ...holes: PathHole[]): NixExpr<NixPath>;
}

const path = ((source: string, options?: PathOptions) =>
  expr<NixPath>({
    kind: "path",
    source: {
      mode: "copy",
      path: source,
      ...(options?.base === undefined ? {} : { base: String(options.base) }),
    },
  })) as PathTag;

path.from =
  (root, options) =>
  (strings, ...holes) =>
    expr<NixPath>({
      kind: "path",
      source: {
        mode: "copy-template",
        root,
        ...(options?.base === undefined ? {} : { base: String(options.base) }),
        template: template(strings, holes),
      },
    });
path.preserve = ((first: string | TemplateStringsArray, ...holes: PathHole[]) => {
  const parts =
    typeof first === "string" ? { strings: [first], holes: [] } : template(first, holes);
  return expr<NixPath>({ kind: "path", source: { mode: "preserve", template: parts } });
}) as PathTag["preserve"];

export const nix = {
  str(strings: TemplateStringsArray, ...holes: StringHole[]): NixExpr<NixString> {
    return expr({ kind: "string-template", template: template(strings, holes) });
  },
  path,
  ident(name: string): NixExpr<unknown> {
    assertIdentifier(name);
    return expr({ kind: "ident", name });
  },
  select<T = unknown>(from: NixExpr<unknown>, ...selection: string[]): NixExpr<T> {
    if (selection.length === 0) throw new TypeError("select requires at least one attribute");
    selection.forEach(assertIdentifier);
    return expr({ kind: "select", from: from.node, path: selection });
  },
  apply<T = unknown>(fn: NixExpr<NixFunction | unknown>, ...args: NixValue[]): NixExpr<T> {
    return expr({ kind: "apply", fn: fn.node, args: args.map(node) });
  },
  lambda(argument: string, body: NixExpr<unknown>): NixExpr<NixFunction> {
    assertIdentifier(argument);
    return expr({ kind: "lambda", argument, body: body.node });
  },
  let<T>(bindings: Readonly<Record<string, NixValue>>, body: NixExpr<T>): NixExpr<T> {
    for (const key of Object.keys(bindings)) assertIdentifier(key);
    return expr({
      kind: "let",
      bindings: Object.fromEntries(Object.entries(bindings).map(([k, v]) => [k, node(v)])),
      body: body.node,
    });
  },
  attrs(value: Readonly<Record<string, NixValue>>): NixExpr<NixAttrSet> {
    return expr(node(value));
  },
  list(value: readonly NixValue[]): NixExpr<NixList> {
    return expr(node(value));
  },
  bool(value: boolean): NixExpr<NixBool> {
    return expr({ kind: "literal", value });
  },
  number(value: number): NixExpr<NixNumber> {
    return expr({ kind: "literal", value });
  },
  package<Outputs extends string = "out">(
    name: string,
    outputs?: readonly Outputs[],
  ): DerivationRef<Outputs> {
    assertIdentifier(name);
    const base = expr<NixDerivation>({
      kind: "select",
      from: { kind: "ident", name: "pkgs" },
      path: [name],
    });
    const names: readonly string[] = outputs ?? ["out"];
    const selectedRecord = Object.fromEntries(
      names.map((output) => {
        assertIdentifier(output);
        return [
          output,
          expr<NixDerivationOutput>({ kind: "select", from: base.node, path: [output] }),
        ];
      }),
    );
    const selected = selectedRecord as { [K in Outputs]: NixExpr<NixDerivationOutput> };
    const out =
      selectedRecord.out ??
      expr<NixDerivationOutput>({ kind: "select", from: base.node, path: ["out"] });
    return Object.assign(base, { outputs: selected, out });
  },
};

export function defineNixosSystem(definition: NixosSystemDefinition): NixosSystemDefinition {
  return definition;
}

export interface FlakeOptions {
  readonly description?: string;
  readonly inputs?: Readonly<Record<string, InputDefinition>>;
  readonly nixosConfigurations?: Readonly<Record<string, NixosSystemDefinition>>;
}

export function defineFlake(options: FlakeOptions): FlakeDefinition {
  return {
    __tsixFlake: true,
    ...(options.description === undefined ? {} : { description: options.description }),
    inputs: options.inputs ?? {},
    nixosConfigurations: options.nixosConfigurations ?? {},
  };
}

export type { DerivationRef, FlakeDefinition, NixExpr } from "@tsix/ir";
