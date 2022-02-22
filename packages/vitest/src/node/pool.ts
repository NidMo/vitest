import { MessageChannel } from 'worker_threads'
import { pathToFileURL } from 'url'
import { cpus } from 'os'
import { resolve } from 'pathe'
import type { Options as TinypoolOptions } from 'tinypool'
import { Tinypool } from 'tinypool'
import { createBirpc } from 'birpc'
import type { RawSourceMap } from 'vite-node'
import type { WorkerContext, WorkerRPC } from '../types'
import { distDir } from '../constants'
import type { Vitest } from './core'

export type RunWithFiles = (files: string[], invalidates?: string[]) => Promise<void>

export interface WorkerPool {
  runTests: RunWithFiles
  collectTests: RunWithFiles
  close: () => Promise<void>
}

/** 创建线程池 */
export function createPool(ctx: Vitest): WorkerPool {
  if (ctx.config.threads)
    return createWorkerPool(ctx)
  else
    return createFakePool(ctx)
}

// runtime目录下的worker.ts
const workerPath = pathToFileURL(resolve(distDir, './worker.js')).href

export function createFakePool(ctx: Vitest): WorkerPool {
  const runWithFiles = (name: 'run' | 'collect'): RunWithFiles => {
    return async(files, invalidates) => {
      const worker = await import(workerPath)

      const { workerPort, port } = createChannel(ctx)

      const data: WorkerContext = {
        port: workerPort,
        config: ctx.getConfig(),
        files,
        invalidates,
        id: 1,
      }

      await worker[name](data, { transferList: [workerPort] })

      port.close()
      workerPort.close()
    }
  }

  return {
    runTests: runWithFiles('run'),
    collectTests: runWithFiles('collect'),
    close: async() => {},
  }
}

/**
 * 创建 web worker 池
 * @description 暴露三个方法出去
 * @description runTests （执行测试文件）---- 执行worker.ts文件里的run方法
 * @description collectTests （收集测试文件）---- 执行worker.ts文件里的collect方法
 * @description close 关闭
 * @param ctx
 * @returns
 */
export function createWorkerPool(ctx: Vitest): WorkerPool {
  // 线程数（至少一个线程）
  const threadsCount = ctx.config.watch
    ? Math.max(cpus().length / 2, 1)
    : Math.max(cpus().length - 1, 1)

  const options: TinypoolOptions = {
    // 引入worker.ts来创建线程
    filename: workerPath,
    // Disable this for now for WebContainers
    // https://github.com/vitest-dev/vitest/issues/93
    useAtomics: typeof process.versions.webcontainer !== 'string',

    maxThreads: ctx.config.maxThreads ?? threadsCount,
    minThreads: ctx.config.minThreads ?? threadsCount,
  }
  if (ctx.config.isolate) {
    options.isolateWorkers = true
    options.concurrentTasksPerWorker = 1
  }

  /** 创建Tinypool，对线程进行通信管理  */
  const pool = new Tinypool(options)

  const runWithFiles = (name: string): RunWithFiles => {
    return async(files, invalidates) => {
      let id = 0
      await Promise.all(files.map(async(file) => {
        const { workerPort, port } = createChannel(ctx)

        const data: WorkerContext = {
          port: workerPort,
          config: ctx.getConfig(),
          files: [file],
          invalidates,
          id: ++id,
        }

        await pool.run(data, { transferList: [workerPort], name })
        port.close()
        workerPort.close()
      }))
    }
  }

  return {
    runTests: runWithFiles('run'),
    collectTests: runWithFiles('collect'),
    close: async() => {}, // TODO: not sure why this will cause Node crash: pool.destroy(),
  }
}

function createChannel(ctx: Vitest) {
  const channel = new MessageChannel()
  const port = channel.port2
  const workerPort = channel.port1

  createBirpc<{}, WorkerRPC>(
    {
      onWorkerExit(code) {
        process.exit(code || 1)
      },
      snapshotSaved(snapshot) {
        ctx.snapshot.add(snapshot)
      },
      async getSourceMap(id, force) {
        if (force) {
          const mod = ctx.server.moduleGraph.getModuleById(id)
          if (mod)
            ctx.server.moduleGraph.invalidateModule(mod)
        }
        const r = await ctx.vitenode.transformRequest(id)
        return r?.map as RawSourceMap | undefined
      },
      fetch(id) {
        return ctx.vitenode.fetchModule(id)
      },
      resolveId(id, importer) {
        return ctx.vitenode.resolveId(id, importer)
      },
      onCollected(files) {
        ctx.state.collectFiles(files)
        ctx.report('onCollected', files)
      },
      onTaskUpdate(packs) {
        ctx.state.updateTasks(packs)
        ctx.report('onTaskUpdate', packs)
      },
      onUserConsoleLog(log) {
        ctx.state.updateUserLog(log)
        ctx.report('onUserConsoleLog', log)
      },
      onFinished(files) {
        ctx.report('onFinished', files)
      },
    },
    {
      post(v) {
        port.postMessage(v)
      },
      on(fn) {
        port.on('message', fn)
      },
    },
  )

  return { workerPort, port }
}
