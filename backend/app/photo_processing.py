"""Decode and normalize stored meal photos without retaining image metadata."""
from __future__ import annotations

from io import BytesIO
import warnings

from PIL import Image, ImageOps, UnidentifiedImageError
from pillow_heif import register_heif_opener

register_heif_opener()
Image.MAX_IMAGE_PIXELS = 40_000_000
MAX_DIMENSION = 1600
MAX_ENCODED_BYTES = 1_000_000


def compress_photo(data: bytes) -> bytes:
    """Return an oriented, metadata-free JPEG bounded in dimensions and bytes."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(BytesIO(data)) as source:
                if source.format not in {'JPEG', 'PNG', 'GIF', 'WEBP', 'HEIF'}:
                    raise ValueError('Unsupported image format')
                source.seek(0)
                oriented = ImageOps.exif_transpose(source)
                oriented.thumbnail((MAX_DIMENSION, MAX_DIMENSION), Image.Resampling.LANCZOS)
                if oriented.mode in ('RGBA', 'LA') or 'transparency' in oriented.info:
                    rgba = oriented.convert('RGBA')
                    image = Image.new('RGB', rgba.size, 'white')
                    image.paste(rgba, mask=rgba.getchannel('A'))
                else:
                    image = oriented.convert('RGB')
                for _ in range(6):
                    for quality in (85, 75, 65, 55):
                        output = BytesIO()
                        image.save(output, format='JPEG', quality=quality, optimize=True)
                        encoded = output.getvalue()
                        if len(encoded) <= MAX_ENCODED_BYTES:
                            return encoded
                    image.thumbnail((max(1, int(image.width * .8)), max(1, int(image.height * .8))), Image.Resampling.LANCZOS)
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ValueError('Could not read this image. Choose a valid JPEG, PNG, GIF, WebP, or HEIC photo.') from exc
    raise ValueError('Image could not be compressed to the size limit.')
