import { notImplemented } from './notImplemented';

/** Typed surface only — real implementations land in Phase 2 (Document Center) / Phase 3 (POD). */
export const documentsApi = {
  list: (_entityType: string, _entityId: string): Promise<unknown[]> =>
    notImplemented('documentsApi.list'),
  initiateUpload: (_body: unknown): Promise<unknown> =>
    notImplemented('documentsApi.initiateUpload'),
  confirmUpload: (_id: string): Promise<unknown> => notImplemented('documentsApi.confirmUpload'),
  getDownloadUrl: (_id: string): Promise<{ url: string }> =>
    notImplemented('documentsApi.getDownloadUrl'),
  review: (_id: string, _body: unknown): Promise<unknown> => notImplemented('documentsApi.review'),
  uploadCarrierDocument: (_carrierId: string, _body: unknown): Promise<unknown> =>
    notImplemented('documentsApi.uploadCarrierDocument'),
  uploadPodDocument: (_loadId: string, _sequence: number, _body: unknown): Promise<unknown> =>
    notImplemented('documentsApi.uploadPodDocument'),
};
