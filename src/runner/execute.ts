import * as fs from 'fs';
import * as readline from 'readline';
import * as assert from 'assert';
import { bulkFind } from '@travetto/base';

import { TestConfig, TestResult, SuiteConfig, SuiteResult, Assertion } from '../model';
import { TestRegistry } from '../service';
import { ConsoleCapture } from './console';
import { AssertUtil } from './assert';
import { Consumer } from '../consumer';
import { SuitePhase } from '..';

export const BREAKOUT = Symbol('breakout');
export const TIMEOUT = Symbol('timeout');

export class ExecuteUtil {

  static timeout = parseInt(process.env.DEFAULT_TIMEOUT || '5000', 10);

  static asyncTimeout(duration?: number) {
    return new Promise((_, reject) => setTimeout(() => reject(TIMEOUT), duration || this.timeout).unref());
  }

  static async generateSuiteError(consumer: Consumer, suite: SuiteConfig, description: string, error: Error) {
    const { line, file } = AssertUtil.readFilePosition(error, suite.file);
    const badAssert: Assertion = {
      line,
      file,
      error,
      message: error.message,
      text: '(outer)',
      operator: 'throws'
    };
    const badTest: TestResult = {
      status: 'fail',
      className: suite.className,
      methodName: description,
      description,
      lines: { start: line, end: line },
      file,
      error,
      assertions: [badAssert],
      output: {}
    };

    const badTestConfig: TestConfig = {
      class: suite.class,
      className: badTest.className,
      file: badTest.file,
      lines: badTest.lines,
      methodName: badTest.methodName,
      description: badTest.description,
      skip: false
    };

    consumer.onEvent({ type: 'test', phase: 'before', test: badTestConfig });
    consumer.onEvent({ type: 'assertion', phase: 'after', assertion: badAssert });
    consumer.onEvent({ type: 'test', phase: 'after', test: badTest });

    return badTest;
  }

  static async affixProcess(consumer: Consumer, phase: SuitePhase, suite: SuiteConfig, result: SuiteResult) {
    try {
      for (const fn of suite[phase]) {
        await Promise.race([this.asyncTimeout(), fn.call(suite.instance)]);
      }
    } catch (error) {
      if (error === TIMEOUT) {
        error = new Error(`${suite.className}: ${phase} timed out`);;
      }
      const res = await this.generateSuiteError(consumer, suite, phase, error);
      result.tests.push(res);
      throw BREAKOUT;
    }
  }

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

  static async getTests(globs: string[]) {
    const files = await bulkFind(globs);
    const all = await Promise.all(files.map(async (f) => [f, await this.isTest(f)] as [string, boolean]));
    return all.filter(x => x[1]).map(x => x[0]);
  }

  static checkError(test: TestConfig, err: Error | string) {
    if (test.shouldError) {
      if (typeof test.shouldError === 'string') {
        if (err.constructor.name === test.shouldError) {
          return;
        } else {
          return new Error(`Expected error to be of type ${test.shouldError}`);
        }
      } else if (test.shouldError instanceof RegExp) {
        if (test.shouldError.test(typeof err === 'string' ? err : err.message)) {
          return;
        } else {
          return new Error(`Expected error to match ${test.shouldError.source}`);
        }
      } else {
        if (test.shouldError(err)) {
          return;
        }
      }
    }
    return err;
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

    try {
      ConsoleCapture.start();

      AssertUtil.start((a) => consumer.onEvent({ type: 'assertion', phase: 'after', assertion: a }));

      const timeout = this.asyncTimeout(test.timeout);
      const res = await Promise.race([suite.instance[test.methodName](), timeout]);
      result.status = 'success';
    } catch (err) {
      if (err === TIMEOUT) {
        err = new Error('Operation timed out');
      } else {
        err = this.checkError(test, err);
      }
      if (!err) {
        result.status = 'success';
      } else {
        result.status = 'fail';
        result.error = err;
      }
    } finally {
      result.output = ConsoleCapture.end();
      result.assertions = AssertUtil.end();
    }

    if (result.status === 'fail' && result.error) {
      const err = result.error;
      if (!(err instanceof assert.AssertionError)) {
        const { file, line } = AssertUtil.readFilePosition(err, test.file);
        const assertion: Assertion = { file, line, operator: 'throws', text: '(uncaught)', error: err, message: err.message };
        // result.output = result.output || {};
        // result.output['error'] = `${(result.output['error'] || '')}\n${err.stack}`;
        result.assertions.push(assertion);
      }
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

    try {
      await this.affixProcess(consumer, 'beforeAll', suite, result);
      await this.affixProcess(consumer, 'beforeEach', suite, result);
      await this.executeTest(consumer, test);
      await this.affixProcess(consumer, 'afterEach', suite, result);
      await this.affixProcess(consumer, 'afterAll', suite, result);
    } catch (e) {
      if (e === BREAKOUT) {
        // Done
      } else {
        const res = await this.generateSuiteError(consumer, suite, 'all', e);
        result.tests.push(res);
      }
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

    try {
      await this.affixProcess(consumer, 'beforeAll', suite, result);

      for (const testConfig of suite.tests) {
        await this.affixProcess(consumer, 'beforeEach', suite, result);

        const ret = await this.executeTest(consumer, testConfig);
        result[ret.status]++;
        result.tests.push(ret);

        await this.affixProcess(consumer, 'afterEach', suite, result);
      }

      await this.affixProcess(consumer, 'afterAll', suite, result);
    } catch (e) {
      if (e === BREAKOUT) {
        // Done
      } else {
        const res = await this.generateSuiteError(consumer, suite, 'all', e);
        result.tests.push(res);
      }
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
        const clses = TestRegistry.getClasses().map(x => TestRegistry.get(x))
        res = [clses];

      }
    }

    return res as any;
  }

  static async execute(consumer: Consumer, [file, ...args]: string[]) {
    if (!file.startsWith(process.cwd())) {
      file = `${process.cwd()}/${file}`;
    }

    require(file);

    await TestRegistry.init();

    const params = this.getRunParams(file, args[0], args[1]);

    const suites: SuiteConfig | SuiteConfig[] = params[0];
    const test = params[1] as TestConfig;

    if (Array.isArray(suites)) {
      for (const suite of suites) {
        await this.executeSuite(consumer, suite);
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