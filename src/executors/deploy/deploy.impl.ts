import { ExecutorContext, logger, readJsonFile } from '@nx/devkit'
import { execCommand, getOutputDirectoryFromBuildTarget } from '@nx-extend/core'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import yargsUnparser from 'yargs-unparser'

import { ContainerFlags, getContainerFlags } from './utils/get-container-flags'

export interface ExecutorSchema extends ContainerFlags {
  name?: string

  buildTarget?: string
  dockerFile: string
  project: string
  tag?: string
  region: string
  allowUnauthenticated?: boolean
  concurrency?: number
  maxInstances?: number
  minInstances?: number
  cloudSqlInstance?: string
  logsDir?: string
  serviceAccount?: string
  tagWithVersion?: boolean
  manifestType?: 'node' | 'python'
  revisionSuffix?: string
  buildWith?: 'artifact-registry'
  noTraffic?: boolean
  timeout?: number
  cpuBoost?: boolean
  ingress?: string
  executionEnvironment?: 'gen1' | 'gen2'
  vpcConnector?: string
  vpcEgress?: 'all-traffic' | 'private-ranges-only'

  // VOLUME_NAME,type=cloud-storage,bucket=BUCKET_NAME
  // VOLUME_NAME,type=in-memory,size=SIZE_LIMIT
  volumeName?: string

  sidecars?: ContainerFlags[]

  // Global options
  dryRun?: boolean
}

export async function deployExecutor(
  options: ExecutorSchema,
  context: ExecutorContext
): Promise<{ success: boolean }> {
  const { root } = context.projectsConfigurations.projects[String(context.projectName)]

  const buildTarget = options.buildTarget || `${context.projectName}:build`
  const outputDirectory = getOutputDirectoryFromBuildTarget(context, buildTarget)

  if (!outputDirectory) {
    throw new Error('Build target has no "outputPath" configured!')
  }

  const {
    region,
    project,
    name = context.projectName,
    allowUnauthenticated = true,
    concurrency,
    maxInstances,
    minInstances,
    cloudSqlInstance,
    serviceAccount,
    tagWithVersion = false,
    manifestType = 'node',
    noTraffic,
    executionEnvironment,
    vpcConnector,
    vpcEgress,
    revisionSuffix,
    timeout,
    cpuBoost,
    ingress,
    // VOLUME_NAME,type=VOLUME_TYPE,size=SIZE_LIMIT'
    volumeName,

    sidecars = []
  } = options

  if (!name) {
    throw new Error('Project name is required (name)')
  }

  const distDirectory = join(context.root, outputDirectory)

  // If the user provided a Dockerfile, then write it to the dist directory
  if (options.dockerFile) {
    const dockerFile = readFileSync(
      join(context.root, options.dockerFile),
      'utf8'
    )

    // Add the docker file to the dist folder
    writeFileSync(join(distDirectory, 'Dockerfile'), dockerFile)
  }

  let packageVersion: string | null = null

  if (tagWithVersion) {  
    if (manifestType === 'node') {
      // Read from package.json only
      const packageJsonPath = join(context.root, root, 'package.json')
      
      if (existsSync(packageJsonPath)) {
        const packageJson = readJsonFile(packageJsonPath)
        if (packageJson?.version) {
          packageVersion = `v${packageJson.version.replace(/\./g, '-')}`
          logger.info(`Using package.json version: ${packageJson.version}`)
        }
      } else {
        logger.warn('tagWithVersion is enabled but package.json not found')
      }
    } else if (manifestType === 'python') {
      // Read from pyproject.toml only
      const pyprojectPath = join(context.root, root, 'pyproject.toml')
      
      if (existsSync(pyprojectPath)) {
        try {
          const pyprojectContent = readFileSync(pyprojectPath, 'utf-8')
          // Match: version = "1.0.0" or version = '1.0.0' with optional whitespace
          const versionMatch = pyprojectContent.match(/^\s*version\s*=\s*["']([^"']+)["']\s*$/m)
          
          if (versionMatch) {
            packageVersion = `v${versionMatch[1].replace(/\./g, '-')}`
            logger.info(`Using pyproject.toml version: ${versionMatch[1]}`)
          } else {
            logger.warn('pyproject.toml found but no version field detected')
          }
        } catch (error) {
          logger.warn(`Failed to parse pyproject.toml: ${error}`)
        }
      } else {
        logger.warn('tagWithVersion is enabled but pyproject.toml not found')
      }
    }
  }

  let gcloudDeploy = 'gcloud run deploy'
  if (options.volumeName) {
    logger.warn('Volumes are still in beta, using "gcloud beta" to deploy.\n')
    gcloudDeploy = 'gcloud beta run deploy'
  }

  // Build command arguments object
  const args = {
    _: [name],
    project,
    platform: 'managed',
    quiet: true,
    region,
    'min-instances': minInstances,
    'max-instances': maxInstances,
    concurrency,
    'execution-environment': executionEnvironment,
    'vpc-connector': vpcConnector,
    'vpc-egress': vpcEgress,
    ingress,
    'revision-suffix': revisionSuffix ?? undefined,
    'service-account': serviceAccount,
    timeout,
    'add-cloudsql-instances': cloudSqlInstance,
    tag: (tagWithVersion && packageVersion) ?? undefined,
    'cpu-boost': cpuBoost,
    'no-traffic': noTraffic ?? undefined,
    'allow-unauthenticated': allowUnauthenticated ?? undefined,
    'add-volume': volumeName ? `name=${volumeName}` : undefined,
  }

  // Convert args to command line flags
  const baseFlags = yargsUnparser(args)
  
  // Get container flags
  const containerFlags = getContainerFlags(options, sidecars.length > 0)
  const sidecarFlags = sidecars.flatMap((sidecarOptions) => getContainerFlags(sidecarOptions, true))

  // Build final command with proper spacing
  const commandParts = [
    gcloudDeploy,
    ...baseFlags,
    ...containerFlags,
    ...sidecarFlags
  ].filter(Boolean)
  
  const fullCommand = commandParts.join(' ')

  return execCommand(fullCommand, {}, options.dryRun)
}

export default deployExecutor
