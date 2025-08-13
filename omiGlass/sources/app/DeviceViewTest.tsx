import * as React from 'react';
import { View, Text, ScrollView, Image, Pressable } from 'react-native';
import { toBase64Image } from '../utils/base64';

function usePhotos(device: BluetoothRemoteGATTServer) {
    const [subscribed, setSubscribed] = React.useState(false);
    const [photos, setPhotos] = React.useState<{ data: Uint8Array, timestamp: number }[]>([]);

    React.useEffect(() => {
        (async () => {
            try {
                console.log('DeviceView: Trying to get omiGlass service...');
                const service = await device.getPrimaryService('19b10000-e8f2-537e-4f6c-d104768a1214');
                console.log('DeviceView: Got service successfully');
                console.log('DeviceView: Getting photo data characteristic...');
                const photoDataCharacteristic = await service.getCharacteristic('19b10005-e8f2-537e-4f6c-d104768a1214');
                console.log('DeviceView: Got photo data characteristic:', photoDataCharacteristic);
                console.log('DeviceView: Starting notifications...');
                await photoDataCharacteristic.startNotifications();
                console.log('DeviceView: Notifications started successfully');
                console.log('DeviceView: Checking notification properties:', {
                    canNotify: photoDataCharacteristic.properties.notify,
                    canIndicate: photoDataCharacteristic.properties.indicate,
                    canRead: photoDataCharacteristic.properties.read
                });

                photoDataCharacteristic.addEventListener('characteristicvaluechanged', (event: any) => {
                    const value = event.target.value;
                    const data = new Uint8Array(value.buffer);
                    console.log('DeviceView: Photo data received:', data.length, 'bytes');
                    setPhotos(prev => [...prev, { data, timestamp: Date.now() }]);
                });

                setSubscribed(true);
                
                console.log('DeviceView: Getting photo control characteristic...');
                const photoControlCharacteristic = await service.getCharacteristic('19b10006-e8f2-537e-4f6c-d104768a1214');
                console.log('DeviceView: Got photo control characteristic:', photoControlCharacteristic);
                console.log('DeviceView: Writing to photo control characteristic...');
                await photoControlCharacteristic.writeValue(new Uint8Array([0x01]));
                console.log('DeviceView: Write operation successful');
                
                console.log('DeviceView: Setup complete');
            } catch (error) {
                console.error('DeviceView: Failed to setup omiGlass service:', error);
                console.error('DeviceView: This device does not support omiGlass service');
            }
        })();
    }, []);

    return [subscribed, photos] as const;
}

// Step-by-step DeviceView rebuild to find the text node issue
export const DeviceViewTest = React.memo((props: { device: BluetoothRemoteGATTServer }) => {
    const [subscribed, photos] = usePhotos(props.device);
    console.log('🧪 Testing DeviceView with photos:', photos.length);
    
    return (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            {/* Display photos in a grid filling the screen */}
            <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#111' }}>
                <ScrollView contentContainerStyle={{ flexDirection: 'row', flexWrap: 'wrap', padding: 5 }}>
                    {photos.slice().reverse().map((photo, index) => (
                        <Pressable
                            key={photos.length - 1 - index}
                            style={{
                                position: 'relative',
                                width: '33%',
                                aspectRatio: 1,
                                padding: 2
                            }}
                        >
                            <Image 
                                style={{ width: '100%', height: '100%', borderRadius: 5 }} 
                                source={{ uri: toBase64Image(photo.data) }} 
                            />
                        </Pressable>
                    ))}
                </ScrollView>
                
                {/* Connection Status Overlay */}
                <View style={{
                    position: 'absolute',
                    top: 50,
                    left: 20,
                    right: 20,
                    backgroundColor: 'rgba(0, 0, 0, 0.8)',
                    padding: 15,
                    borderRadius: 10,
                    alignItems: 'center'
                }}>
                    <Text style={{ color: '#00ff00', fontSize: 16, fontWeight: 'bold' }}>
                        ✅ OpenGlass Connected
                    </Text>
                    <Text style={{ color: 'white', fontSize: 12, marginTop: 5 }}>
                        Subscribed: {subscribed ? '✅' : '❌'}
                    </Text>
                    <Text style={{ color: 'white', fontSize: 12, marginTop: 2 }}>
                        Photos received: {photos?.length || 0}
                    </Text>
                </View>
            </View>
        </View>
    );
});
