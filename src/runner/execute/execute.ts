import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as assert from 'assert';
import { bulkFind, BaseError, AppEnv } from '@travetto/base';

import { TestConfig, TestResult, SuiteConfig, SuiteResult, Assertion } from '../../model';
import { TestRegistry } from '../../service';
import { ConsoleCapture } from '../console';
import { AssertUtil } from './../assert';
import { Consumer } from '../../consumer';
import { asyncTimeout, TIMEOUT, ExecutionPhaseManager } from './phase';

export class ExecuteUtil {

  static isTest(file: string) {
    return new Promise<boolean>((resolve, reject) => {
      const input = fs.createReadStream(file);
      const reader = readline.createInterface({ input })
        .on('line', line => {
          if (line.includes('@Suite')) {
            resolve(true);
            reader.close();
          }
        })
        .on('end', resolve.bind(null, false))
        .on('close', resolve.bind(null, false));
    });
  }

  static async getTests(globs: RegExp[]) {
    const files = (await bulkFind(globs.map(x => ({ testFile: (y: string) => x.test(y) }))))
      .filter(x => !x.stats.isDirectory())
      .filter(x => !x.file.includes('node_modules'))
      .map(f => this.isTest(f.file).then(valid => ({ file: f.file, valid })));

    return (await Promise.all(files))
      .filter(x => x.valid)
      .map(x => x.file);
  }

  static checkError(test: TestConfig, err: Error | string | undefined) {
    const st = test.shouldThrow!;

    if (typeof st === 'boolean') {
      if (err && !st) {
        throw new Error('Expected an error to not be thrown');
      } else if (!err && st) {
        throw new Error('Expected an error to be thrown');
      }
    } else if (typeof st === 'string' || st instanceof RegExp) {
      const actual = `${err instanceof Error ? `'${err.message}'` : (err ? `'${err}'` : 'nothing')}`;

      if (typeof st === 'string' && (!err || !(err instanceof Error ? err.message : err).includes(st))) {
        return new Error(`Expected error containing text '${st}', but got ${actual}`);
      }
      if (st instanceof RegExp && (!err || !st.test(typeof err === 'string' ? err : err.message))) {
        return new Error(`Expected error with message matching '${st.source}', but got ${actual}`);
      }
    } else if (st === Error || st === BaseError || Object.getPrototypeOf(st) !== Object.getPrototypeOf(Function)) { // if not simple function, treat as class
      if (!err || !(err instanceof st)) {
        return new Error(`Expected to throw ${st.name}, but got ${err || 'nothing'}`);
      }
    } else {
      return st(err);
    }
  }

  static async executeTest(consumer: Consumer, test: TestConfig) {

    consumer.onEvent({ type: 'test', phase: 'before', test });

    const suite = TestRegistry.get(test.class);
    const result: Partial<TestResult> = {
      methodName: test.methodName,
      description: test.description,
      className: test.className,
      lines: { ...test.lines },
      file: test.file,
      status: 'skip'
    };

    if (test.skip) {
      return result as TestResult;
    }

    const [timeout, clear] = asyncTimeout(test.timeout);

    try {
      ConsoleCapture.start();

      AssertUtil.start(test, (a) => {
        consumer.onEvent({ type: 'assertion', phase: 'after', assertion: a });
      });

      const res = await Promise.race([suite.instance[test.methodName](), timeout]);

      // Ensure nothing was meant to be caught
      throw undefined;

    } catch (err) {
      if (err === TIMEOUT) {
        err = new Error('Operation timed out');
      } else if (test.shouldThrow) {
        err = this.checkError(test, err);
      }

      // If error isn't defined, we are good
      if (!err) {
        result.status = 'success';
      } else {
        result.status = 'fail';
        result.error = err;

        if (!(err instanceof assert.AssertionError)) {
          let line = AssertUtil.readFilePosition(err, test.file).line;
          if (line === 1) {
            line = test.lines.start;
          }

          AssertUtil.add({
            className: test.className,
            methodName: test.methodName,
            file: test.file,
            line,
            operator: 'throws',
            error: err,
            message: err.message,
            text: '(uncaught)'
          });
        }
      }
    } finally {
      clear();
      result.output = ConsoleCapture.end();
      result.assertions = AssertUtil.end();
    }

    consumer.onEvent({ type: 'test', phase: 'after', test: result as TestResult });

    return result as TestResult;
  }

  static async executeSuiteTest(consumer: Consumer, suite: SuiteConfig, test: TestConfig) {
    const result: SuiteResult = {
      success: 0,
      fail: 0,
      skip: 0,
      total: 0,
      lines: { ...suite.lines },
      file: suite.file,
      className: suite.className,
      tests: []
    };

    const mgr = new ExecutionPhaseManager(consumer, suite, result);

    try {
      await mgr.startPhase('all');
      await mgr.startPhase('each');
      await this.executeTest(consumer, test);
      await mgr.endPhase('each');
      await mgr.endPhase('all');
    } catch (e) {
      await mgr.onError(e);
    }
  }

  static async executeSuite(consumer: Consumer, suite: SuiteConfig) {
    const result: SuiteResult = {
      success: 0,
      fail: 0,
      skip: 0,
      total: 0,
      lines: { ...suite.lines },
      file: suite.file,
      className: suite.className,
      tests: []
    };

    consumer.onEvent({ phase: 'before', type: 'suite', suite });

    const mgr = new ExecutionPhaseManager(consumer, suite, result);

    try {
      await mgr.startPhase('all');

      for (const testConfig of suite.tests) {
        await mgr.startPhase('each');

        const ret = await this.executeTest(consumer, testConfig);
        result[ret.status]++;
        result.tests.push(ret);

        await mgr.endPhase('each');
      }
      await mgr.endPhase('all');
    } catch (e) {
      await mgr.onError(e);
    }

    consumer.onEvent({ phase: 'after', type: 'suite', suite: result });

    result.total = result.success + result.fail;

    return result as SuiteResult;
  }

  static getRunParams(file: string, clsName?: string, method?: string): [SuiteConfig] | [SuiteConfig, TestConfig] | [SuiteConfig[]] {
    let res = undefined;
    if (clsName && /^\d+$/.test(clsName)) {
      const line = parseInt(clsName, 10);
      const clses = TestRegistry.getClasses().filter(f => f.__filename === file).map(x => TestRegistry.get(x));
      const cls = clses.find(x => line >= x.lines.start && line <= x.lines.end);
      if (cls) {
        const meth = cls.tests.find(x => line >= x.lines.start && line <= x.lines.end);
        if (meth) {
          res = [cls, meth];
        } else {
          res = [cls];
        }
      } else {
        res = [clses];
      }
    } else {
      if (method) {
        const cls = TestRegistry.getClasses().find(x => x.name === clsName)!;
        const clsConf = TestRegistry.get(cls);
        const meth = clsConf.tests.find(x => x.methodName === method)!;
        res = [clsConf, meth];
      } else if (clsName) {
        const cls = TestRegistry.getClasses().find(x => x.name === clsName)!;
        const clsConf = TestRegistry.get(cls);
        res = [clsConf];
      } else {
        const clses = TestRegistry.getClasses().map(x => TestRegistry.get(x));
        res = [clses];
      }
    }

    return res as any;
  }

  static async execute(consumer: Consumer, [file, ...args]: string[]) {
    if (!file.startsWith(AppEnv.cwd)) {
      file = path.join(AppEnv.cwd, file);
    }

    require(file.replace(/[\\]/g, '/')); // Path to module

    if (process.env.DEBUGGER) {
      await new Promise(t => setTimeout(t, 100));
    }

    await TestRegistry.init();

    const params = this.getRunParams(file, args[0], args[1]);

    const suites: SuiteConfig | SuiteConfig[] = params[0];
    const test = params[1] as TestConfig;

    if (Array.isArray(suites)) {
      for (const suite of suites) {
        if (suite.tests.length) {
          await this.executeSuite(consumer, suite);
        }
      }
    } else {
      if (test) {
        await this.executeSuiteTest(consumer, suites, test);
      } else {
        await this.executeSuite(consumer, suites);
      }
    }
  }
}