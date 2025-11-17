// ./tools/s3/listFiles.ts

interface ListFilesInput {
  bucket: string;
  prefix?: string;
  extension?: string;
}

interface S3File {
  key: string;
  size: number;
  lastModified: string;
}

interface ListFilesResponse {
  files: S3File[];
  bucket: string;
  count: number;
}

/**
 * List files from an S3 bucket
 *
 * Retrieves a list of files from the specified S3 bucket, optionally filtered by prefix and file extension.
 *
 * @param input - Object containing bucket name, optional prefix, and optional extension filter
 * @returns Promise resolving to list of S3 files with metadata
 *
 * Example:
 * ```typescript
 * const result = await listFiles({
 *   bucket: 'my-bucket',
 *   prefix: 'documents/',
 *   extension: '.txt'
 * });
 * console.log(`Found ${result.files.length} files`);
 * ```
 */
export async function listFiles(input: ListFilesInput): Promise<ListFilesResponse> {
  // In a real implementation, this would call AWS S3 API:
  // const s3 = new S3Client({
  //   region: process.env.AWS_REGION,
  //   credentials: {
  //     accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
  //     secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  //   },
  // });
  // const command = new ListObjectsV2Command({ Bucket: input.bucket, Prefix: input.prefix });
  // const response = await s3.send(command);

  // Mock implementation for demonstration
  const mockFiles: S3File[] = [
    { key: 'documents/file1.txt', size: 1024, lastModified: new Date().toISOString() },
    { key: 'documents/file2.txt', size: 2048, lastModified: new Date().toISOString() },
    { key: 'documents/file3.txt', size: 1536, lastModified: new Date().toISOString() },
  ];

  let filteredFiles = mockFiles;

  if (input.prefix) {
    filteredFiles = filteredFiles.filter(f => f.key.startsWith(input.prefix!));
  }

  if (input.extension) {
    filteredFiles = filteredFiles.filter(f => f.key.endsWith(input.extension!));
  }

  console.log(`[S3] Listing files from bucket: ${input.bucket}`);
  console.log(`[S3] Found ${filteredFiles.length} files`);

  return {
    files: filteredFiles,
    bucket: input.bucket,
    count: filteredFiles.length,
  };
}

