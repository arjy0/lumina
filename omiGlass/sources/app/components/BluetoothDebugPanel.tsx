import * as React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { testWebBluetoothSupport, scanForAnyBLEDevice, testWithServiceFilter } from '../../modules/bluetoothTest';

export const BluetoothDebugPanel = React.memo(() => {
    const [log, setLog] = React.useState<string[]>([]);

    const addLog = (message: string) => {
        setLog(prev => [...prev.slice(-10), message]); // Keep last 10 messages
    };

    // Override console.log temporarily to capture logs
    React.useEffect(() => {
        const originalLog = console.log;
        const originalError = console.error;
        
        console.log = (...args) => {
            originalLog(...args);
            addLog(`LOG: ${args.join(' ')}`);
        };
        
        console.error = (...args) => {
            originalError(...args);
            addLog(`ERROR: ${args.join(' ')}`);
        };
        
        return () => {
            console.log = originalLog;
            console.error = originalError;
        };
    }, []);

    const runTest = async (testFunction: () => Promise<void>, testName: string) => {
        addLog(`=== Starting ${testName} ===`);
        try {
            await testFunction();
        } catch (error) {
            addLog(`Test ${testName} failed: ${error}`);
        }
    };

    return (
        <View style={styles.container}>
            <Text style={styles.title}>Bluetooth Debug Panel</Text>
            
            <TouchableOpacity 
                style={styles.button} 
                onPress={() => runTest(testWebBluetoothSupport, 'Support Test')}
            >
                <Text style={styles.buttonText}>Test Web Bluetooth Support</Text>
            </TouchableOpacity>
            
            <TouchableOpacity 
                style={styles.button} 
                onPress={() => runTest(scanForAnyBLEDevice, 'Scan All Devices')}
            >
                <Text style={styles.buttonText}>Scan for ANY BLE Device</Text>
            </TouchableOpacity>
            
            <TouchableOpacity 
                style={styles.button} 
                onPress={() => runTest(
                    () => testWithServiceFilter('19b10000-e8f2-537e-4f6c-d104768a1214'), 
                    'OpenGlass Service Test'
                )}
            >
                <Text style={styles.buttonText}>Test OpenGlass Service</Text>
            </TouchableOpacity>
            
            <TouchableOpacity 
                style={[styles.button, styles.clearButton]} 
                onPress={() => setLog([])}
            >
                <Text style={styles.buttonText}>Clear Log</Text>
            </TouchableOpacity>
            
            <View style={styles.logContainer}>
                <Text style={styles.logTitle}>Debug Log:</Text>
                {log.map((line, index) => (
                    <Text key={index} style={styles.logText}>{line}</Text>
                ))}
            </View>
        </View>
    );
});

const styles = StyleSheet.create({
    container: {
        padding: 20,
        backgroundColor: '#f0f0f0',
    },
    title: {
        fontSize: 18,
        fontWeight: 'bold',
        marginBottom: 20,
        textAlign: 'center',
    },
    button: {
        backgroundColor: '#007AFF',
        padding: 15,
        borderRadius: 8,
        marginBottom: 10,
    },
    clearButton: {
        backgroundColor: '#FF3B30',
    },
    buttonText: {
        color: 'white',
        textAlign: 'center',
        fontSize: 16,
        fontWeight: '600',
    },
    logContainer: {
        marginTop: 20,
        backgroundColor: '#000',
        padding: 10,
        borderRadius: 8,
        maxHeight: 300,
    },
    logTitle: {
        color: '#00FF00',
        fontSize: 14,
        fontWeight: 'bold',
        marginBottom: 10,
    },
    logText: {
        color: '#00FF00',
        fontSize: 12,
        fontFamily: 'monospace',
        marginBottom: 2,
    },
});
