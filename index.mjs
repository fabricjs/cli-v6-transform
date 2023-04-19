#!/usr/bin/env node

import cp from "child_process";
import * as commander from "commander";
import fs from "fs-extra";
import fuzzy from "fuzzy";
import inquirer from "inquirer";
import Checkbox from "inquirer-checkbox-plus-prompt";
import _ from "lodash";
import path from "node:path";
import process from "node:process";
import { listFiles, transform as transformFiles } from "./transformFiles.mjs";

const program = new commander.Command();
const wd = "./";

function execGitCommand(cmd) {
  return cp
    .execSync(cmd, { cwd: wd })
    .toString()
    .replace(/\n/g, ",")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function getGitInfo(branchRef) {
  const branch = execGitCommand("git branch --show-current")[0];
  const tag = execGitCommand("git describe --tags")[0];
  const uncommittedChanges = execGitCommand("git status --porcelain").map(
    (value) => {
      const [type, path] = value.split(" ");
      return { type, path };
    }
  );
  const changes = execGitCommand(`git diff ${branchRef} --name-only`);
  const userName = execGitCommand("git config user.name")[0];
  return {
    branch,
    tag,
    uncommittedChanges,
    changes,
    user: userName,
  };
}

class ICheckbox extends Checkbox {
  constructor(questions, rl, answers) {
    super(questions, rl, answers);
    this.opt.source = this.opt.source.bind(this);
  }
  getCurrentValue() {
    const current = super.getCurrentValue();
    return current.concat(this.firstSourceLoading ? this.default : []);
  }
  onSpaceKey() {
    const choice = this.choices.getChoice(this.pointer);
    if (!choice) {
      return;
    }

    this.toggleChoice(choice);
    if (choice.value && !choice.value.file) {
      delete this.lastQuery;
      // Remove the choices from the checked values with the same type
      _.remove(this.value, (v) => v.type === choice.value.type && v.file);
      _.remove(this.checkedChoices, (checkedChoice) => {
        if (!checkedChoice.value.file) {
          return false;
        }
        checkedChoice.checked = false;
        return checkedChoice.value.type === choice.value.type;
      });

      this.executeSource();
    }

    this.render();
  }
}
inquirer.registerPrompt("test-selection", ICheckbox);

/**
 *
 * @param {'unit'|'visual'} type corresponds to the test directories
 * @returns
 */
function listTestFiles(type) {
  return fs.readdirSync(path.resolve(wd, "./test", type)).filter((p) => {
    const ext = path.parse(p).ext.slice(1);
    return ext === "js" || ext === "ts";
  });
}

// function writeCLIFile(tests) {
//   fs.writeFileSync(CLI_CACHE, JSON.stringify(tests, null, "\t"));
// }

// function readCLIFile() {
//   return fs.existsSync(CLI_CACHE) ? JSON.parse(fs.readFileSync(CLI_CACHE)) : [];
// }

function createChoiceData(type, file) {
  return {
    name: `${type}/${file}`,
    short: `${type}/${file}`,
    value: {
      type,
      file,
    },
  };
}

async function selectFileToTransform() {
  const files = _.map(listFiles(), ({ dir, file }) =>
    createChoiceData(
      path.relative(path.resolve(wd, "src"), dir).replaceAll("\\", "/"),
      file
    )
  );
  const { tests: filteredTests } = await inquirer.prompt([
    {
      type: "test-selection",
      name: "tests",
      message: "Select files to transform to es6",
      highlight: true,
      searchable: true,
      default: [],
      pageSize: 10,
      source(answersSoFar, input = "") {
        return new Promise((resolve) => {
          const value = _.map(this.getCurrentValue(), (value) =>
            createChoiceData(value.type, value.file)
          );
          const res = fuzzy
            .filter(input, files, {
              extract: (item) => item.name,
            })
            .map((element) => element.original);
          resolve(value.concat(_.differenceBy(res, value, "name")));
        });
      },
    },
  ]);
  return filteredTests.map(({ type, file }) =>
    path.resolve(wd, "src", type, file)
  );
}

program
  .name("fabric.js v6 file transformer")
  .description("fabric.js DEV CLI tools")
  .version(process.env.npm_package_version)
  .showSuggestionAfterError();

program
  .command("transform")
  .description("transforms files into es6")
  .option("-o, --overwrite", "overwrite exisitng files", false)
  .option("-x, --no-exports", "do not use exports")
  .option("-i, --index", "create index files", false)
  .option("-ts, --typescript", "transform into typescript", false)
  .option("-v, --verbose", "verbose logging", true)
  .option("--no-verbose", "verbose logging")
  .option("-a, --all", "transform all files", false)
  .option(
    "-d, --diff <branch>",
    "compare against given branch (default: master) and transform all files with diff"
  )
  .action(
    async ({
      overwrite,
      exports,
      index,
      typescript,
      verbose,
      all,
      diff: gitRef,
    } = {}) => {
      let files = [];
      if (gitRef) {
        gitRef = gitRef === true ? "master" : gitRef;
        const { changes } = getGitInfo(gitRef);
        files = changes.map((change) => path.resolve(wd, change));
      } else if (!all) {
        files = await selectFileToTransform();
      }
      transformFiles({
        overwriteExisitingFiles: overwrite,
        useExports: exports,
        createIndex: index,
        ext: typescript ? "ts" : "js",
        verbose,
        files,
      });
    }
  );

program.parse(process.argv);
