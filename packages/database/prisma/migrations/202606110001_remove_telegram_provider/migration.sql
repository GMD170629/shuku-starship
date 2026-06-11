DELETE FROM `SourceSearchRecord` WHERE `providerType` = 'telegram';

DELETE FROM `Source` WHERE `providerType` = 'telegram';

UPDATE `DownloadTask`
SET
  `status` = 'failed',
  `errorMessage` = 'telegram provider 已移除，请改用 Z-Library 源重新搜索下载。',
  `updatedAt` = CURRENT_TIMESTAMP(3)
WHERE `type` = 'telegram'
  AND `status` IN ('queued', 'downloading', 'downloaded', 'importing', 'PENDING', 'FAILED');
