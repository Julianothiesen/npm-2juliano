'use strict'

const { mkdir, symlink, unlink, rm } = require('fs/promises')
const { promisify } = require('util')

const Arborist = require('@npmcli/arborist')
const ciDetect = require('@npmcli/ci-detect')
const crypto = require('crypto')
const log = require('proc-log')
const npa = require('npm-package-arg')
const npmlog = require('npmlog')
const pacote = require('pacote')
const read = promisify(require('read'))
const semver = require('semver')
const binLinks = require('bin-links')
binLinks.linkBins = require('bin-links/lib/link-bins')

const { fileExists, localFileExists } = require('./file-exists.js')
const getBinFromManifest = require('./get-bin-from-manifest.js')
const noTTY = require('./no-tty.js')
const runScript = require('./run-script.js')
const isWindows = require('./is-windows.js')

const { dirname, resolve } = require('path')

const binPaths = []

// when checking the local tree we look up manifests, cache those results by
// spec.raw so we don't have to fetch again when we check npxCache
const manifests = new Map()

const getManifest = async (spec, flatOptions) => {
  if (!manifests.has(spec.raw)) {
    const manifest = await pacote.manifest(spec, { ...flatOptions, preferOnline: true })
    manifests.set(spec.raw, manifest)
  }
  return manifests.get(spec.raw)
}

// Returns the required manifest if the spec is missing from the tree
// Returns the found node if it is in the tree
const missingFromTree = async ({ spec, tree, flatOptions }) => {
  if (spec.registry && spec.type !== 'tag') {
    // registry spec that is not a specific tag.
    const nodesBySpec = tree.inventory.query('packageName', spec.name)
    for (const node of nodesBySpec) {
      // package requested by name only (or name@*)
      if (spec.rawSpec === '*') {
        return { node }
      }
      // package requested by specific version
      if (spec.type === 'version' && (node.pkgid === spec.raw)) {
        return { node }
      }
      // package requested by version range, only remaining registry type
      if (semver.satisfies(node.package.version, spec.rawSpec)) {
        return { node }
      }
    }
    const manifest = await getManifest(spec, flatOptions)
    return { manifest }
  } else {
    // non-registry spec, or a specific tag.  Look up manifest and check
    // resolved to see if it's in the tree.
    const manifest = await getManifest(spec, flatOptions)
    if (spec.type === 'directory') {
      return { manifest }
    }
    const nodesByManifest = tree.inventory.query('packageName', manifest.name)
    for (const node of nodesByManifest) {
      if (node.package.resolved === manifest._resolved) {
        // we have a package by the same name and the same resolved destination, nothing to add.
        return { node }
      }
    }
    return { manifest }
  }
}

const exec = async (opts) => {
  const {
    args = [],
    call = '',
    localBin = resolve('./node_modules/.bin'),
    locationMsg = undefined,
    globalBin = '',
    globalPath,
    output,
    // dereference values because we manipulate it later
    packages: [...packages] = [],
    path = '.',
    runPath = '.',
    scriptShell = isWindows ? process.env.ComSpec || 'cmd' : 'sh',
    ...flatOptions
  } = opts

  let yes = opts.yes
  const run = () => runScript({
    args,
    call,
    flatOptions,
    locationMsg,
    output,
    path,
    binPaths,
    runPath,
    scriptShell,
  })

  // interactive mode
  if (!call && !args.length && !packages.length) {
    return run()
  }

  const needPackageCommandSwap = (args.length > 0) && (packages.length === 0)
  // If they asked for a command w/o specifying a package, see if there is a
  // bin that directly matches that name:
  // - in the local package itself
  // - in the local tree
  // - globally
  if (needPackageCommandSwap) {
    const localManifest = await pacote.manifest(path, flatOptions).catch(() => null)
    const manifestBinPath = localManifest?.bin?.[args[0]]
    if (manifestBinPath && await fileExists(resolve(path, manifestBinPath))) {
      const tmpNmPath = resolve(path, 'node_modules', localManifest.name)
      const tmpDir = await mkdir(dirname(tmpNmPath), { recursive: true })
      await symlink(path, tmpNmPath, 'dir')

      // only link the bin that we already know exists in case anything else would fail
      const binOpts = {
        force: false,
        path: tmpNmPath,
        pkg: { bin: { [args[0]]: manifestBinPath } },
      }
      // binLinks returns null if it was created and false if not so if we have
      // a valid path here then we can keep going. if we did not create a bin
      // here then keep trying the next steps below, since there is probably
      // a bin that is already linked there which we will run.
      const linkedBins = await binLinks.linkBins(binOpts).catch(() => []).then((r) => {
        return r[0] === null ? binLinks.getPaths(binOpts) : []
      })

      const cleanupLinks = async () => {
        // always unlink symlinks when we are done
        await unlink(tmpNmPath)
        if (linkedBins.length) {
          await Promise.all(linkedBins.map(b => unlink(b)))
        }
        // Only if mkdir indicated that it created a dir should we cleanup
        // that directory
        if (tmpDir) {
          await rm(tmpDir, { recursive: true, force: true })
        }
      }

      if (linkedBins.length) {
        binPaths.push(path)
        return await run().finally(cleanupLinks)
      } else {
        // if we didnt create a bin then we still might need to cleanup the
        // symlinked directory we created
        await cleanupLinks()
      }
    }

    const localBinDir = dirname(dirname(localBin))
    const localBinPath = await localFileExists(localBinDir, args[0], '/')
    if (localBinPath) {
      binPaths.push(localBinPath)
      return await run()
    }

    if (globalPath && await fileExists(`${globalBin}/${args[0]}`)) {
      binPaths.push(globalBin)
      return await run()
    }

    // We swap out args[0] with the bin from the manifest later
    packages.push(args[0])
  }

  // Resolve any directory specs so that the npx directory is unique to the
  // resolved directory, not the potentially relative one (i.e. "npx .")
  for (const i in packages) {
    const pkg = packages[i]
    const spec = npa(pkg)
    if (spec.type === 'directory') {
      packages[i] = spec.fetchSpec
    }
  }

  const localArb = new Arborist({ ...flatOptions, path })
  const localTree = await localArb.loadActual()

  // Find anything that isn't installed locally
  const needInstall = []
  let commandManifest
  await Promise.all(packages.map(async (pkg, i) => {
    const spec = npa(pkg, path)
    const { manifest, node } = await missingFromTree({ spec, tree: localTree, flatOptions })
    if (manifest) {
      // Package does not exist in the local tree
      needInstall.push({ spec, manifest })
      if (i === 0) {
        commandManifest = manifest
      }
    } else if (i === 0) {
      // The node.package has enough to look up the bin
      commandManifest = node.package
    }
  }))

  if (needPackageCommandSwap) {
    const spec = npa(args[0])

    if (spec.type === 'directory') {
      yes = true
    }

    args[0] = getBinFromManifest(commandManifest)

    if (needInstall.length > 0 && globalPath) {
      // See if the package is installed globally, and run the translated bin
      const globalArb = new Arborist({ ...flatOptions, path: globalPath, global: true })
      const globalTree = await globalArb.loadActual()
      const { manifest: globalManifest } =
        await missingFromTree({ spec, tree: globalTree, flatOptions })
      if (!globalManifest && await fileExists(`${globalBin}/${args[0]}`)) {
        binPaths.push(globalBin)
        return await run()
      }
    }
  }

  const add = []
  if (needInstall.length > 0) {
    // Install things to the npx cache, if needed
    const { npxCache } = flatOptions
    if (!npxCache) {
      throw new Error('Must provide a valid npxCache path')
    }
    const hash = crypto.createHash('sha512')
      .update(packages.map(p => {
        // Keeps the npx directory unique to the resolved directory, not the
        // potentially relative one (i.e. "npx .")
        const spec = npa(p)
        if (spec.type === 'directory') {
          return spec.fetchSpec
        }
        return p
      }).sort((a, b) => a.localeCompare(b, 'en')).join('\n'))
      .digest('hex')
      .slice(0, 16)
    const installDir = resolve(npxCache, hash)
    await mkdir(installDir, { recursive: true })
    const npxArb = new Arborist({
      ...flatOptions,
      path: installDir,
    })
    const npxTree = await npxArb.loadActual()
    await Promise.all(needInstall.map(async ({ spec }) => {
      const { manifest } = await missingFromTree({ spec, tree: npxTree, flatOptions })
      if (manifest) {
        // Manifest is not in npxCache, we need to install it there
        if (!spec.registry) {
          add.push(manifest._from)
        } else {
          add.push(manifest._id)
        }
      }
    }))

    if (add.length) {
      if (!yes) {
        // set -n to always say no
        if (yes === false) {
          throw new Error('canceled')
        }

        if (noTTY() || ciDetect()) {
          log.warn('exec', `The following package${
            add.length === 1 ? ' was' : 's were'
          } not found and will be installed: ${
            add.map((pkg) => pkg.replace(/@$/, '')).join(', ')
          }`)
        } else {
          const addList = add.map(a => `  ${a.replace(/@$/, '')}`)
            .join('\n') + '\n'
          const prompt = `Need to install the following packages:\n${
          addList
        }Ok to proceed? `
          npmlog.clearProgress()
          const confirm = await read({ prompt, default: 'y' })
          if (confirm.trim().toLowerCase().charAt(0) !== 'y') {
            throw new Error('canceled')
          }
        }
      }
      await npxArb.reify({
        ...flatOptions,
        add,
      })
    }
    binPaths.push(resolve(installDir, 'node_modules/.bin'))
  }

  return await run()
}

module.exports = exec
