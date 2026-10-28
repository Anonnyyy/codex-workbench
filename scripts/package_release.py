"""Build an allowlisted portable archive with a SHA-256 verified Node runtime."""
import argparse, hashlib, json, os, pathlib, shutil, subprocess, tarfile, urllib.request, zipfile

root = pathlib.Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--target', choices=['win-x64', 'linux-x64'], required=True)
parser.add_argument('--output', default=str(root/'releases'))
args = parser.parse_args()
version = json.loads((root/'package.json').read_text())['version']
runtime = json.loads((root/'scripts/node-runtime.json').read_text())
output = pathlib.Path(args.output).resolve(); output.mkdir(parents=True, exist_ok=True)
name = 'codex-workbench-'+args.target
stage = output/name
if stage.exists(): raise SystemExit('Output already exists; use a new --output directory: '+str(stage))
stage.mkdir()

for filename in ['package.json','package-lock.json','LICENSE','README.md','THIRD-PARTY-NOTICES.md',
                 'Start-Workbench.cmd','Start-Workbench.ps1','Start-Workbench.sh','Create-Desktop-Shortcut.cmd']:
    shutil.copy2(root/filename, stage/filename)
for folder in ['dist','public','server']:
    shutil.copytree(root/folder,stage/folder,ignore=shutil.ignore_patterns('__pycache__','*.pyc','*.log'))
(stage/'src').mkdir()
for filename in ['model.js','capacityRetry.js','messageQueue.js','systemNotifications.js']:
    shutil.copy2(root/'src'/filename,stage/'src'/filename)
(stage/'scripts').mkdir()
for filename in ['launch.mjs','desktop-shortcut.ps1']:
    shutil.copy2(root/'scripts'/filename,stage/'scripts'/filename)

npm = shutil.which('npm.cmd' if os.name=='nt' else 'npm')
if not npm: raise SystemExit('Build requires npm; release users do not need it.')
subprocess.run([npm,'ci','--omit=dev','--omit=optional','--ignore-scripts','--no-audit','--no-fund'],cwd=stage,check=True)

ext = '.zip' if args.target=='win-x64' else '.tar.xz'
artifact = 'node-v'+runtime['version']+'-'+args.target+ext
cache = root/'.release-cache'; cache.mkdir(exist_ok=True)
download = cache/artifact
if not download.exists():
    with urllib.request.urlopen('https://nodejs.org/dist/v'+runtime['version']+'/'+artifact,timeout=120) as response, download.open('wb') as f:
        shutil.copyfileobj(response,f)
if hashlib.sha256(download.read_bytes()).hexdigest()!=runtime[args.target]:
    raise SystemExit('Runtime checksum mismatch: '+str(download))
(stage/'runtime').mkdir()
prefix = 'node-v'+runtime['version']+'-'+args.target+'/'
if args.target=='win-x64':
    with zipfile.ZipFile(download) as z:
        for source,dest in [('node.exe','node.exe'),('LICENSE','LICENSE')]:
            (stage/'runtime'/dest).write_bytes(z.read(prefix+source))
else:
    with tarfile.open(download) as t:
        for source,dest in [('bin/node','node'),('LICENSE','LICENSE')]:
            (stage/'runtime'/dest).write_bytes(t.extractfile(prefix+source).read())
    (stage/'runtime/node').chmod(0o755)
(stage/'Start-Workbench.sh').chmod(0o755)
(stage/'VERSION').write_text(version+'\n',encoding='utf-8')
archive = output/(name+('.zip' if args.target=='win-x64' else '.tar.gz'))
if args.target=='win-x64':
    with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
        for path in sorted(stage.rglob('*')):
            if path.is_file(): z.write(path,path.relative_to(output).as_posix())
else:
    # Windows chmod does not encode execute bits; set tar member modes explicitly.
    def permissions(info):
        info.uid=info.gid=0;info.uname=info.gname=''
        info.mode=0o755 if info.isdir() or info.name.endswith(('/runtime/node','/Start-Workbench.sh')) else 0o644
        return info
    with tarfile.open(archive,'w:gz') as t: t.add(stage,arcname=name,filter=permissions)
print(json.dumps({'archive':str(archive),'stage':str(stage),'sha256':hashlib.sha256(archive.read_bytes()).hexdigest()}))
