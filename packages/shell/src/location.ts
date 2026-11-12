import { LOCATION_PATHS, type LocationKey, type ResolvedSettings, type Settings } from '@qaily/contracts';

type S3 = Settings['connections']['s3'];

/** Where the report reads its data from, fixed when the page loads. */
export type DataLocation = Pick<S3, LocationKey> & {
  /** The bucket or folder the viewer chose personally, for the header; null when the page loaded the report's own. */
  personal: string | null;
};

/** The storage settings this page loaded with. Personal changes to them apply after a reload. */
export function locationOf(s3: Pick<S3, LocationKey>): Pick<S3, LocationKey> {
  const keys = LOCATION_PATHS.map((p) => p.slice('connections.s3.'.length) as LocationKey);
  return Object.fromEntries(keys.map((k) => [k, s3[k]])) as Pick<S3, LocationKey>;
}

/**
 * The personal location to name in the header: the data folder first, since a report reading from the bucket shows
 * that, with the bucket in front when the viewer chose another bucket or storage service.
 */
export function personalFolder(s3: S3, sources: ResolvedSettings['sources']): string | null {
  const mine = (p: string) => sources[p] === 'personal';
  if (!LOCATION_PATHS.some(mine)) return null;
  const folder = s3.dataSource === 'bucket' && (mine('connections.s3.dataPrefix') || !mine('connections.s3.prefix')) ? s3.dataPrefix : s3.prefix;
  const path = folder.replace(/^\/+|\/+$/g, '');
  const otherBucket = ['bucket', 'region', 'endpoint', 'pathStyle'].some((k) => mine(`connections.s3.${k}`));
  if (otherBucket) return path ? `${s3.bucket}/${path}` : s3.bucket;
  return path || '(bucket root)';
}
