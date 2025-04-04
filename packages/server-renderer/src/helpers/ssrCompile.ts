import {
  type ComponentInternalInstance,
  type ComponentOptions,
  warn,
} from 'vue'
import { compile } from '@vue/compiler-ssr'
import { NO, extend, generateCodeFrame, isFunction } from '@vue/shared'
import type { CompilerError, CompilerOptions } from '@vue/compiler-core'
import type { PushFn } from '../render'

import * as Vue from 'vue'
import * as helpers from '../internal'

type SSRRenderFunction = (
  context: any,
  push: PushFn,
  parentInstance: ComponentInternalInstance,
) => void

// Define a memory limit for the cache, defaulting to 500MB, I don't really know how to read it from the config.
const DEFAULT_CACHE_SIZE_LIMIT = 1024 * 1024 * 500

// LFU Cache implementation
class LFUCache {
  private cache: Map<string, SSRRenderFunction> = new Map()
  private frequencies: Map<string, number> = new Map()
  private frequencyLists: Map<number, Set<string>> = new Map()
  private minFrequency: number = 0
  private size: number = 0
  private sizeLimit: number

  constructor(sizeLimit: number = DEFAULT_CACHE_SIZE_LIMIT) {
    this.sizeLimit = sizeLimit
  }

  has(key: string): boolean {
    return this.cache.has(key)
  }

  get(key: string): SSRRenderFunction | undefined {
    if (!this.cache.has(key)) {
      return undefined
    }

    // Increase frequency count for this key
    const frequency = this.frequencies.get(key) || 0
    this.frequencies.set(key, frequency + 1)

    // Update frequency lists
    this.frequencyLists.get(frequency)?.delete(key)
    if (this.frequencyLists.get(frequency)?.size === 0) {
      this.frequencyLists.delete(frequency)
      if (this.minFrequency === frequency) {
        this.minFrequency = frequency + 1
      }
    }

    if (!this.frequencyLists.has(frequency + 1)) {
      this.frequencyLists.set(frequency + 1, new Set())
    }
    this.frequencyLists.get(frequency + 1)?.add(key)

    return this.cache.get(key)
  }

  set(key: string, value: SSRRenderFunction): void {
    if (this.cache.has(key)) {
      // Update existing entry
      const oldSize = this.estimateSize(this.cache.get(key)!)
      const newSize = this.estimateSize(value)
      this.size = this.size - oldSize + newSize
      this.cache.set(key, value)
      return
    }

    const valueSize = this.estimateSize(value)

    // If single item is larger than cache limit, just store it without evicting
    // (it will eventually be evicted when another item is added)
    if (valueSize > this.sizeLimit && this.cache.size > 0) {
      if (__DEV__) {
        warn(`[@vue/server-renderer] Compiled template is larger than cache limit and won't be cached`)
      }
      return
    }

    // Evict items if necessary to make space
    while (this.size + valueSize > this.sizeLimit && this.cache.size > 0) {
      this.evict()
    }

    // Add new item to cache
    this.cache.set(key, value)
    this.frequencies.set(key, 1)
    if (!this.frequencyLists.has(1)) {
      this.frequencyLists.set(1, new Set())
    }
    this.frequencyLists.get(1)?.add(key)
    this.size += valueSize
    this.minFrequency = 1
  }

  private evict(): void {
    if (this.minFrequency === 0 || !this.frequencyLists.has(this.minFrequency)) {
      return
    }

    const frequencies = this.frequencyLists.get(this.minFrequency)!
    if (frequencies.size === 0) {
      this.frequencyLists.delete(this.minFrequency)
      return
    }

    // Get the first key from the set of least frequently used items
    const keyToEvict = frequencies.values().next().value
    frequencies.delete(keyToEvict)

    if (frequencies.size === 0) {
      this.frequencyLists.delete(this.minFrequency)
    }

    // Update cache size
    const evictedSize = this.estimateSize(this.cache.get(keyToEvict)!)
    this.size -= evictedSize

    // Remove from maps
    this.cache.delete(keyToEvict)
    this.frequencies.delete(keyToEvict)

    // Recalculate min frequency if needed
    if (this.frequencyLists.size === 0) {
      this.minFrequency = 0
    } else if (!this.frequencyLists.has(this.minFrequency)) {
      this.minFrequency = Math.min(...Array.from(this.frequencyLists.keys()))
    }
  }

  // Estimate the size of a function in memory
  private estimateSize(fn: SSRRenderFunction): number {
    // Simple approximation based on string length
    // In a real implementation, you might want a more accurate way to measure
    const fnStr = fn.toString()
    // Estimate 2 bytes per character (for UTF-16)
    return fnStr.length * 2
  }
}

// Create an LFU cache instance
const compileCache = new LFUCache()

export function ssrCompile(
  template: string,
  instance: ComponentInternalInstance,
): SSRRenderFunction {
  // TODO: this branch should now work in ESM builds, enable it in a minor
  if (!__CJS__) {
    throw new Error(
      `On-the-fly template compilation is not supported in the ESM build of ` +
        `@vue/server-renderer. All templates must be pre-compiled into ` +
        `render functions.`,
    )
  }

  // TODO: This is copied from runtime-core/src/component.ts and should probably be refactored
  const Component = instance.type as ComponentOptions
  const { isCustomElement, compilerOptions } = instance.appContext.config
  const { delimiters, compilerOptions: componentCompilerOptions } = Component

  const finalCompilerOptions: CompilerOptions = extend(
    extend(
      {
        isCustomElement,
        delimiters,
      },
      compilerOptions,
    ),
    componentCompilerOptions,
  )

  finalCompilerOptions.isCustomElement =
    finalCompilerOptions.isCustomElement || NO
  finalCompilerOptions.isNativeTag = finalCompilerOptions.isNativeTag || NO

  const cacheKey = JSON.stringify(
    {
      template,
      compilerOptions: finalCompilerOptions,
    },
    (key, value) => {
      return isFunction(value) ? value.toString() : value
    },
  )

  const cached = compileCache.get(cacheKey)
  if (cached) {
    return cached
  }

  finalCompilerOptions.onError = (err: CompilerError) => {
    if (__DEV__) {
      const message = `[@vue/server-renderer] Template compilation error: ${err.message}`
      const codeFrame =
        err.loc &&
        generateCodeFrame(
          template as string,
          err.loc.start.offset,
          err.loc.end.offset,
        )
      warn(codeFrame ? `${message}\n${codeFrame}` : message)
    } else {
      throw err
    }
  }

  const { code } = compile(template, finalCompilerOptions)
  const requireMap = {
    vue: Vue,
    'vue/server-renderer': helpers,
  }
  const fakeRequire = (id: 'vue' | 'vue/server-renderer') => requireMap[id]
  const renderFunction = Function('require', code)(fakeRequire)

  // Store in cache
  compileCache.set(cacheKey, renderFunction)

  return renderFunction
}