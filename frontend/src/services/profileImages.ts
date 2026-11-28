import { ApiError } from './api';

type Requester = <T>(path: string, init?: RequestInit) => Promise<T>;
type Streamer = (path: string) => Promise<Response>;

export async function uploadProfileImage<T>(request: Requester, path: string, image: Blob): Promise<T> {
  const form = new FormData();
  form.append('file', image, 'avatar.jpg');
  return request<T>(path, { method: 'POST', body: form });
}

export async function dataUrlToImage(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);
  return response.blob();
}

export async function loadPrivateAvatar(stream: Streamer, path: string): Promise<string | null> {
  try {
    const response = await stream(path);
    return URL.createObjectURL(await response.blob());
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 404) return null;
    throw error;
  }
}

type ReceptionistAvatarProfile = { profile?: { avatarUrl?: string | null } };

export async function loadReceptionistAvatar(stream: Streamer, request: Requester): Promise<string | null> {
  const uploaded = await loadPrivateAvatar(stream, '/api/receptionists/me/avatar');
  if (uploaded) return uploaded;

  const record = await request<ReceptionistAvatarProfile & { data?: ReceptionistAvatarProfile }>('/api/receptionists/me');
  const avatar = (record.data ?? record).profile?.avatarUrl;
  if (!avatar) return null;
  try {
    const url = new URL(avatar);
    return url.protocol === 'https:' && url.host === 'res.cloudinary.com' && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
