import { definePlugin, defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";
export default definePlugin({
  meta: { name: "raio" },
  rules: {
    syntax: defineRule({
      meta: {
        type: "problem",
        schema: [],
        messages: { forbidden: "Use explicit immutable state, typed failures and owned exports." },
      },
      create(context) {
        const reject = (node: ESTree.Node) => context.report({ node, messageId: "forbidden" });
        return {
          Program() {
            for (const comment of context.sourceCode.getAllComments())
              context.report({ loc: comment.loc, messageId: "forbidden" });
          },
          VariableDeclaration(node) {
            if (node.kind === "let" || node.kind === "var") reject(node);
          },
          ConditionalExpression: reject,
          SwitchStatement: reject,
          TryStatement: reject,
          ExportAllDeclaration: reject,
          BinaryExpression(node) {
            if (node.operator === "instanceof") reject(node);
          },
        };
      },
    }),
  },
});
