import fs from 'fs';
import path from 'path';
import readline from 'readline';

const configDir = './';
var total_size = 0;

if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
}
  
const configExists = (file) => {
    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, JSON.stringify({}, null, 2));
    }
};

const saveFile = (file, data) => fs.writeFileSync(`${configDir}/${file}`, JSON.stringify(data, null, 2));

const loadFile = (file) => {
    configExists(`${configDir}/${file}`);
    return JSON.parse(fs.readFileSync(`${configDir}/${file}`, 'utf8'));
};

const config = loadFile('config.json');
const logFile = path.join(process.cwd(), 'error.log');

function logErrorToFile(error) {
    const errorMessage = `[${new Date().toISOString()}] ${error.stack || error}\n`;
    fs.appendFileSync(logFile, errorMessage);
}

function setupLogger(logFileName = "backup.log") {
    const logFile = path.join(process.cwd(), logFileName);
    const logStream = fs.createWriteStream(logFile, { flags: "a" });
  
    let buffer = ""; // Puffer für nicht abgeschlossene Zeilen
  
    // Originale Streams speichern
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
  
    function logToFileAndConsole(chunk) {
      const message = typeof chunk === "string" ? chunk : chunk.toString();
  
      // Nachricht in den Puffer aufnehmen
      buffer += message;
  
      // Wenn \n in der Nachricht enthalten ist, logge die komplette Zeile
      if (message.includes("\n")) {
        const parts = buffer.split("\n");
        for (let i = 0; i < parts.length - 1; i++) {
          const timestampedMessage = `[${new Date().toISOString()}] ${parts[i]}\n`;
          logStream.write(timestampedMessage); // In Datei schreiben
          originalStdoutWrite.call(process.stdout, parts[i] + "\n"); // In Konsole ausgeben
        }
        // Den letzten, unvollständigen Teil im Puffer behalten
        buffer = parts[parts.length - 1];
      }
    }
  
    // Überschreiben der Streams
    process.stdout.write = (chunk, ...args) => logToFileAndConsole(chunk, ...args);
    process.stderr.write = (chunk, ...args) => logToFileAndConsole(chunk, ...args);
  
    // console.log überschreiben (fügt automatisch \n hinzu)
    const originalLog = console.log;
    console.log = (...args) => {
      const message = args.map(arg => (typeof arg === "object" ? JSON.stringify(arg) : String(arg))).join(" ");
      logToFileAndConsole(message + "\n");
    };
  
    // Funktion zum Beenden des Loggings
    return () => {
      if (buffer) { // Den letzten Pufferinhalt auch speichern
        const timestampedMessage = `[${new Date().toISOString()}] ${buffer}`;
        logStream.write(timestampedMessage);
      }
      logStream.end();
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      console.log = originalLog;
    };
  }

const start = Date.now();
const timestamp = new Date().toISOString().replace(/[:T]/g, '-').split('.')[0];

function rotateBackups() {
    try {
        const MAX_BACKUPS = config.MAX_BACKUPS;
        const BACKUP_DIR = config.BACKUP_DIR;

        if (!fs.existsSync(config.BACKUP_DIR)) {
            fs.mkdirSync(config.BACKUP_DIR, { recursive: true });
        }

        let mainBackupDir = fs.readdirSync(BACKUP_DIR)
            .find(name => name.startsWith('main_'));

        if (!mainBackupDir) {
            mainBackupDir = `main_${timestamp}`;
            fs.mkdirSync(path.join(BACKUP_DIR, mainBackupDir), { recursive: true });
            config.BACKUP_FOLDER = path.join(BACKUP_DIR, mainBackupDir);
        } else {
            const newBackup = path.join(BACKUP_DIR, `backup_${timestamp}`);
            config.BACKUP_FOLDER = newBackup;
            fs.mkdirSync(newBackup, { recursive: true });
    
            let backups = fs.readdirSync(BACKUP_DIR)
                .filter(name => name.startsWith('backup_'))
                .map(name => ({
                    name,
                    time: fs.statSync(path.join(BACKUP_DIR, name)).ctime.getTime()
                }))
                .sort((a, b) => a.time - b.time);
    
            while (backups.length > MAX_BACKUPS) {
                const oldest = backups.shift();
                const oldestPath = path.join(BACKUP_DIR, oldest.name);
                fs.rmSync(oldestPath, { recursive: true, force: true });
            }
        }

    } catch (err) {
        console.error("Fehler bei der Backup-Rotation:", err);
    }
}

async function getAccessToken() {
    try {
        const response = await fetch('https://developer.api.autodesk.com/authentication/v2/token', {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${Buffer.from(`${config.CLIENT_ID}:${config.CLIENT_SECRET}`).toString('base64')}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                grant_type: 'client_credentials',
                scope: 'data:read',
            }),
        });

        if (!response.ok) {
            throw new Error(`Fehler beim Abrufen des Tokens: ${response.statusText}`);
        }

        const data = await response.json();
        return data.access_token;
    } catch (error) {
        console.error(error);
    }
}

async function listHubs() {
    const token = await getAccessToken();
    const response = await fetch('https://developer.api.autodesk.com/project/v1/hubs', {
        headers: { Authorization: `Bearer ${token}` }
    });
    const data = await response.json();
    return data.data;
}

async function listProjects() {
    const stopLogging = setupLogger(`${config.BACKUP_FOLDER.replace(config.BACKUP_DIR+"\\","")}.log`);
    const hubs = await listHubs();
    for (const hub of hubs) {
        console.log(`Hub: ${hub.attributes.name} / ${hub.id}`);
        const token = await getAccessToken();
        const response = await fetch(`https://developer.api.autodesk.com/project/v1/hubs/${hub.id}/projects`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const projects = await response.json();

        const exclusiveSet = new Set(config.EXCLUSIVE ? config.EXCLUSIVE.split(",").map(p => p.trim()) : []);
        const excludeSet = new Set(config.EXCLUDE ? config.EXCLUDE.split(",").map(p => p.trim()) : []);

        for (const project of projects.data) {
            const projectName = project.attributes.name;
            if ((exclusiveSet.size === 0 || exclusiveSet.has(projectName)) && !excludeSet.has(projectName))
            {
                const itemPath = path.join(config.BACKUP_FOLDER, project.attributes.name.replace(/[<>:"/\\|?*]+/g, "_"));
                fs.mkdirSync(itemPath, { recursive: true });

                console.log(`\nProjekt: ${project.attributes.name} (${project.id})`);

                const token = await getAccessToken();
                const response = await fetch(`https://developer.api.autodesk.com/project/v1/hubs/${hub.id}/projects/${project.id}/topFolders`, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                const data = await response.json();
                
                try {
                    for (const folder of data.data) {
                        if(folder.attributes.displayName ==="Project Files") {
                            console.log( "└─  " +folder.attributes.displayName);
                            await listFiles(folder.id, project.id, 2, itemPath);
                        }              
                    }
                } catch (error) {
                    logErrorToFile(error);
                }                
            } 
        }
    }
    
    const end = Date.now();
    const durationMs = end - start;
    const h = String(Math.floor(durationMs / 3600000)).padStart(2, '0');
    const m = String(Math.floor((durationMs % 3600000) / 60000)).padStart(2, '0');
    const s = String(Math.floor((durationMs % 60000) / 1000)).padStart(2, '0');

    console.log(`\nLaufzeit: ${h}:${m}:${s}, Backupgröße ${formatBytes(total_size)}`);
    stopLogging();
    setTimeout(() => {
        process.exit(0);
    }, 5000);
}

function formatBytes(bytes) {
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    if (bytes === 0) return "0 Bytes";
    
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(2) + " " + sizes[i];
}

async function testDownloadSpeed() {
    const startTime = Date.now();
    let receivedBytes = 0;

    console.log('Speedtest:');

    const url = 'https://fsn1-speed.hetzner.com/100MB.bin';

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Fehler beim Abrufen der Datei: ${response.statusText}`);

    const reader = response.body.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        receivedBytes += value.length;
    }

    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000; // in Sekunden
    const speedMbps = (receivedBytes * 8) / (duration * 1_000_000); // Megabit pro Sekunde

    console.log(`Heruntergeladen: ${(receivedBytes / 1_048_576).toFixed(2)} MB | Dauer: ${duration.toFixed(2)} Sekunden | Geschwindigkeit: ${speedMbps.toFixed(2)} Mbps\n`);

    return speedMbps;
}

function getDownloadTime(size,speed = 100) {
    const estimatedTimeMinutes = Math.ceil((size * 8) / (speed * 1_000_000) / 60);
    //mind. 2, max. 60 wegen api beschränkungen
    return Math.max(2, Math.min(estimatedTimeMinutes, 60));
}

async function downloadFile(urn, filename, folderPath, projectId) {
    const token = await getAccessToken();
    const CHUNK_SIZE = 2000000000;
    let err = false;
    let download = true;

    const response = await fetch(`https://developer.api.autodesk.com/data/v1/projects/${projectId}/items/${urn}`, {
        headers: { Authorization: `Bearer ${token}` }
    });

    const data = await response.json();

    const size = formatBytes(data.included[0].attributes.storageSize);
    process.stdout.write(` - ${size}`);

    if(config.BACKUP_FOLDER.includes('main_')) {
        download = true;
    } else {
        download = false;

        let mainBackupDir = fs.readdirSync(config.BACKUP_DIR)
            .find(name => name.startsWith('main_'));

        let originalFile = folderPath.replace(/backup_\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}/, mainBackupDir);

        if (!fs.existsSync(originalFile)) {
            download = true;
        } else {
            fs.stat(originalFile, (err, stats) => {
                if (err) {
                  console.error('Fehler beim Abrufen der Datei-Statistik:', err);
                  return;
                }
                if(stats.mtime.toString() === new Date(data.included[0].attributes.lastModifiedTime).toString()) {
                    download = false;
                    //start as administrator to use symlinks
                    fs.symlink(originalFile, folderPath, (err) => {
                        if (err) {
                            fs.symlink(originalFile, folderPath, 'junction', (err) => {
                                if (err) {
                                    fs.link(originalFile, folderPath, (err) => {
                                        if (err) {                                    
                                          //logErrorToFile(`Fehler beim Erstellen des Hardlinks (${folderPath}): ${err}`);
                                        }
                                      });
                                      //logErrorToFile(`Fehler beim Erstellen des Junction: ${err}`);
                                }
                              });
                            //logErrorToFile(`Fehler beim Erstellen des Symlinks: ${err} - als Admin ausführen!`);
                        }
                      });
                } else {
                    download = true;
                }   
              });
        }
    }

    if(download) {
        try {
            let downloadurl = data.included[0].relationships.storage.meta.link.href.split("?");
            process.stdout.write(` ${getDownloadTime(size,config.SPEED)} `);
            const fileresponse = await fetch(downloadurl[0]+"/signeds3download?minutesExpiration="+getDownloadTime(data.included[0].attributes.storageSize,config.SPEED), {
                headers: { Authorization: `Bearer ${token}` }
            });
            const fileData = await fileresponse.json();
        
            const fileUrl = fileData.url;    
            const filePath = path.join(folderPath);
            let start = 0;
            let partCounter = 1;
        
            const fileStream = fs.createWriteStream(filePath);
        
            try {
                while (true) {
                    const end = start + CHUNK_SIZE - 1;
                    const chunkResponse = await fetch(fileUrl, {
                        headers: { Range: `bytes=${start}-${end}` }
                    });
        
                    if (!chunkResponse.ok && chunkResponse.status !== 206 && chunkResponse.status !== 200) {
                        process.stdout.write(` 🔴 Fehler\n`);
                        logErrorToFile(`Fehler beim Herunterladen der Datei ${filename}: ${chunkResponse.statusText}`);
                        err = true;
                    }
        
                    const chunkBuffer = await chunkResponse.arrayBuffer();
                    fileStream.write(Buffer.from(chunkBuffer));
        
                    start += CHUNK_SIZE;
                    //partCounter++;
        
                    if (chunkBuffer.byteLength < CHUNK_SIZE) {
                        break;
                    }
                }
            } catch (error) {
                process.stdout.write(` 🔴 Fehler\n`);
                logErrorToFile(error);
                console.error(`Fehler beim Schreiben der Datei ${filename}:`, error);
                err = true;
            } finally {
                fileStream.end();
                if(!err) { process.stdout.write(` 🟢 gespeichert\n`); }
                fs.utimes(filePath, new Date(data.included[0].attributes.createTime), new Date(data.included[0].attributes.lastModifiedTime), (err) => {
                    if (err) {
                        console.error(`Fehler beim Setzen der Datei-Zeitstempel: ${err.message}`);
                    }
                });
                total_size += data.included[0].attributes.storageSize;
            }            
        } catch {
            logErrorToFile(JSON.stringify(data,null,2));
        }
    } else {
        process.stdout.write(` 🔵 keine Änderung\n`);
    }
}

async function listFiles(folderId, projectId, depth = 0, localPath) {
    const token = await getAccessToken();
    const response = await fetch(`https://developer.api.autodesk.com/data/v1/projects/${projectId}/folders/${folderId}/contents`, {
        headers: { Authorization: `Bearer ${token}` }
    });

    const data = await response.json();

    for (const content of data.data) {
        const indent = "  ".repeat(depth) + "└─ ";
        const name = content.attributes.displayName;
        const itemPath = path.join(localPath, name.replace(/[<>:"/\\|?*]+/g, "_"));
        const str = indent +" "+ name;
        process.stdout.write(str);
        if(content.type === 'folders') {
            fs.mkdirSync(itemPath, { recursive: true });
            process.stdout.write('\n');
            await listFiles(content.id, projectId, depth + 2, itemPath);
        } else if (content.type === 'items') {
            
            await downloadFile(content.id, name, itemPath, projectId)
        }
    }    
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const askQuestion = (question) => {
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
        resolve(answer);
        });
    });
};

const init = async () => {
    if (Object.hasOwn(config, 'CLIENT_ID')) {
        return config;
    } else {
        try {
            console.log('Bitte Client Id & Client Secret eigeben');
            var CLIENT_ID = await askQuestion('Client Id: ');
            var CLIENT_SECRET = await askQuestion('Client Secret: ');
            var BACKUP_DIR = await askQuestion('Backup Verzeichnis: ');
            var MAX_BACKUPS = await askQuestion('Wieviele Backups behalten: ');
            var EXCLUSIVE = await askQuestion('Nur diese Projekte sichern: ');
            var EXCLUDE = await askQuestion('Projekte ausschließen: ');
     
            config.CLIENT_ID = CLIENT_ID;
            config.CLIENT_SECRET = CLIENT_SECRET;
            config.BACKUP_DIR = BACKUP_DIR;
            config.MAX_BACKUPS = MAX_BACKUPS;
            config.EXCLUSIVE = EXCLUSIVE;
            config.EXCLUDE = EXCLUDE;
                
            saveFile('config.json',config);
        
            rl.close();
            return config;
        
            } catch (error) {
                console.error(`Ein Fehler ist aufgetreten`, error);
        }
    }
};

async function backupProjects() {
    rotateBackups();
    config.SPEED = await testDownloadSpeed();
    listProjects();
}

init().then(() => {
    backupProjects()
    .catch(error => {
        console.error('Fehler:', error.message);
    });
});