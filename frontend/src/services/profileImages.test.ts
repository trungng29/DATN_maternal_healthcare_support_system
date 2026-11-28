import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { loadReceptionistAvatar } from './profileImages';

const seededImage = 'https://res.cloudinary.com/demo/image/upload/staff.webp';
const missing = () => Promise.reject(new ApiError('missing', 404));

describe('receptionist avatar', () => {
  it('uses the seeded Cloudinary URL when the private avatar is absent', async () => {
    const request = vi.fn().mockResolvedValue({ profile: { avatarUrl: seededImage } });
    await expect(loadReceptionistAvatar(missing, request)).resolves.toBe(seededImage);
    expect(request).toHaveBeenCalledWith('/api/receptionists/me');
  });

  it('keeps a private upload ahead of the seeded profile image', async () => {
    const stream = () => Promise.resolve(new Response(new Blob(['image'])));
    const request = vi.fn();
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: () => 'blob:private' }));
    try {
      await expect(loadReceptionistAvatar(stream, request)).resolves.toBe('blob:private');
      expect(request).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('ignores unsupported URLs', async () => {
    const request = vi.fn().mockResolvedValue({
      data: { profile: { avatarUrl: 'https://invalid.example/staff.webp' } },
    });
    await expect(loadReceptionistAvatar(missing, request)).resolves.toBeNull();
  });
});
