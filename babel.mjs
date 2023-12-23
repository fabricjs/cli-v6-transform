// https://github.com/jamiebuilds/babel-handbook/blob/master/translations/en/plugin-handbook.md#toc-babel-parser
import parser from "@babel/parser";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import generate from "@babel/generator";
import { readFileSync, writeFileSync } from "fs";

const code = `function square(n) {
  return n * n;
}`;

const ast = parser.parse(readFileSync("./collaboardCanvas.ts").toString(), {
  sourceType: "module",
  locations: true,
  plugins: ["typescript"],
});

traverse.default(ast, {
  // ExpressionStatement(path) {

  // },
  enter(path) {
    if (t.isIdentifier(path.node, { name: "createClass" })) {
      const {
        node: { arguments: args },
      } = path.findParent((parent) => t.isCallExpression(parent));
      let last = args.pop();
      if (t.isIdentifier(last)) {
        traverse.default(ast, {
          VariableDeclarator(path) {
            if (path.node.id.name === last.name) {
              last = path;
              path.stop();
              return;
            }
          },
        });
      }

      last.traverse({
        /**
         *
         * @param {t.ObjectMethod} path
         */
        ObjectMethod(path) {
          path.replaceWith(
            t.classMethod(
              "method",
              path.node.key,
              path.node.params,
              path.node.body,
              path.node.computed,
              false,
              path.node.generator,
              path.node.async
            )
          );
        },
        /**
         *
         * @param {t.ObjectTypeProperty} path
         */
        ObjectProperty(path) {
          //   console.log('??"', path.node.key, path.key);
          path.replaceWith(
            t.classProperty(
              path.node.key,
              path.node.value,
              path.node.typeAnnotation
            )
          );
        },
      });
      console.log(last.parentPath);
      //   last.replaceWith(
      //     t.classDeclaration(
      //       last.findParent(t.isVariableDeclaration).node.id,
      //       null,
      //       {
      //         type: "ClassBody",
      //         body: last.node.init.properties,
      //       }
      //     )
      //   );
    }
  },
});

const { code: output } = generate.default(
  ast,
  {
    retainLines: false,
    compact: "auto",
    concise: false,
    quotes: "single",
  },
  code
);

writeFileSync("./out.ts", output);
writeFileSync("./ast.json", JSON.stringify(ast, null, 2));
