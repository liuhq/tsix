export type NixString = { readonly __nixString: unique symbol };
export type NixPath = { readonly __nixPath: unique symbol };
export type NixDerivation = { readonly __nixDerivation: unique symbol };
export type NixDerivationOutput = { readonly __nixDerivationOutput: unique symbol };
export type NixAttrSet = { readonly __nixAttrSet: unique symbol };
export type NixList = { readonly __nixList: unique symbol };
export type NixBool = { readonly __nixBool: unique symbol };
export type NixNumber = { readonly __nixNumber: unique symbol };
export type NixFunction = { readonly __nixFunction: unique symbol };

export type Primitive = string | number | boolean | null;

export type TemplateHole = Primitive | NixExpr<unknown>;
export interface TemplateParts {
  readonly strings: readonly string[];
  readonly holes: readonly TemplateHole[];
}

export type ExprNode =
  | { readonly kind: "literal"; readonly value: Primitive }
  | { readonly kind: "ident"; readonly name: string }
  | { readonly kind: "select"; readonly from: ExprNode; readonly path: readonly string[] }
  | { readonly kind: "apply"; readonly fn: ExprNode; readonly args: readonly ExprNode[] }
  | { readonly kind: "lambda"; readonly argument: string; readonly body: ExprNode }
  | {
      readonly kind: "let";
      readonly bindings: Readonly<Record<string, ExprNode>>;
      readonly body: ExprNode;
    }
  | { readonly kind: "attrset"; readonly attrs: Readonly<Record<string, ExprNode>> }
  | { readonly kind: "list"; readonly items: readonly ExprNode[] }
  | { readonly kind: "string-template"; readonly template: TemplateParts }
  | { readonly kind: "path"; readonly source: PathSource };

export type PathSource =
  | { readonly mode: "copy"; readonly path: string; readonly base?: string }
  | {
      readonly mode: "copy-template";
      readonly root: string;
      readonly base?: string;
      readonly template: TemplateParts;
    }
  | { readonly mode: "preserve"; readonly template: TemplateParts };

const expressionBrand: unique symbol = Symbol.for("tsix.expression");

export interface NixExpr<T> {
  readonly [expressionBrand]: T;
  readonly node: ExprNode;
}

export function expr<T>(node: ExprNode): NixExpr<T> {
  return { [expressionBrand]: undefined as T, node };
}

export function isExpr(value: unknown): value is NixExpr<unknown> {
  return typeof value === "object" && value !== null && expressionBrand in value;
}

export interface DerivationRef<Outputs extends string = "out"> extends NixExpr<NixDerivation> {
  readonly outputs: Readonly<{ [K in Outputs]: NixExpr<NixDerivationOutput> }>;
  readonly out: NixExpr<NixDerivationOutput>;
}

export interface InputDefinition {
  readonly url?: string;
  readonly follows?: string;
}

export interface NixosSystemDefinition {
  readonly system: string;
  readonly modules: readonly NixExpr<NixAttrSet>[];
  readonly specialArgs?: NixExpr<NixAttrSet>;
}

export interface FlakeDefinition {
  readonly __tsixFlake: true;
  readonly description?: string;
  readonly inputs: Readonly<Record<string, InputDefinition>>;
  readonly nixosConfigurations: Readonly<Record<string, NixosSystemDefinition>>;
  readonly entryFile?: string;
}
