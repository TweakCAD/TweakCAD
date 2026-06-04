export { localStore, inferStorage } from './localStore.ts';
export type { LocalProjectRecord, StorageSnapshot } from './localStore.ts';
export { AutosaveScheduler } from './autosave.ts';
export type { SaveStatus } from './autosave.ts';
export { resolveInitialProject } from './boot.ts';
export type { BootResolution } from './boot.ts';
export type { ProjectContext } from './context.ts';
export { getCurrentSession } from './session.ts';
export type { SessionResponse } from './session.ts';
export {
  probeSaas,
  refreshSaasState,
  getSaasState,
  onSaasStateChange,
  isSaasAvailable,
  isSignedIn,
} from './saasState.ts';
export type { SaasState, SaasUser } from './saasState.ts';
export { useSaasState } from './useSaasState.ts';
export type { DocumentStorage } from './documentStorage.ts';
export { storageLabel, storageIcon, suggestFilename } from './documentStorage.ts';
export {
  isFileSystemAccessSupported,
  openFileFromDisk,
  pickGeometryForImport,
  pickComponentForImport,
  saveFileAs,
  writeToHandle,
} from './diskAdapter.ts';
export type {
  ImportPickResult,
  ComponentImportPickResult,
  OpenResult,
  SaveResult,
} from './diskAdapter.ts';
export {
  newDocument,
  openFromDisk,
  save,
  saveAsToDisk,
  saveAsNewCloudProject,
} from './fileOps.ts';
export type { FileOpsHandles } from './fileOps.ts';
