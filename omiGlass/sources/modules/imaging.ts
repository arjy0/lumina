export function rotateImage(src: Uint8Array, angle: '90' | '180' | '270') {
    return new Promise<Uint8Array>((resolve, reject) => {
        const img = new Image();
        let blobUrl: string | null = null;
        
        // Add timeout to prevent hanging
        const timeout = setTimeout(() => {
            if (blobUrl) URL.revokeObjectURL(blobUrl);
            reject(new Error('Image loading timeout after 5 seconds'));
        }, 5000);
        
        img.onload = () => {
            clearTimeout(timeout);
            try {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d')!;
                canvas.width = img.height;
                canvas.height = img.width;
                ctx.translate(canvas.width / 2, canvas.height / 2);
                ctx.rotate(angle === '90' ? Math.PI / 2 : angle === '180' ? Math.PI : Math.PI * 1.5);
                ctx.drawImage(img, -img.width / 2, -img.height / 2);
                canvas.toBlob(blob => {
                    if (blobUrl) URL.revokeObjectURL(blobUrl);
                    if (blob) {
                        const reader = new FileReader();
                        reader.onload = () => {
                            resolve(new Uint8Array(reader.result as ArrayBuffer));
                        };
                        reader.onerror = () => {
                            reject(new Error('Failed to read rotated image data'));
                        };
                        reader.readAsArrayBuffer(blob);
                    } else {
                        reject(new Error('Failed to create rotated image blob'));
                    }
                }, 'image/jpeg');
            } catch (error) {
                if (blobUrl) URL.revokeObjectURL(blobUrl);
                reject(error);
            }
        };
        
        img.onerror = () => {
            clearTimeout(timeout);
            if (blobUrl) URL.revokeObjectURL(blobUrl);
            reject(new Error('Failed to load image for rotation'));
        };
        
        try {
            blobUrl = URL.createObjectURL(new Blob([src], { type: 'image/jpeg' }));
            img.src = blobUrl;
        } catch (error) {
            clearTimeout(timeout);
            reject(error);
        }
    });
}