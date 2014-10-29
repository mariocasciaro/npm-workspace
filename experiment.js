var     child_process = require('child_process')
// does spawning npm work?

console.log(process.platform);

process.chdir('C:/Gits/npm-workspace/bin/');
var child = child_process.spawn("cmd", ['/c npm-workspace.bat install'], {cwd : 'C:/Gits/npm-workspace/bin/'});

if (child) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', function (data) {
        console.log(data);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', function (data) {
        console.log(data);
    });

    child.on('close', function(code, signal) {
        console.log("child exited "+code);
        process.exit(0);
    });
    child.on('error', function(err) {
        console.log("child failed "+err);
        process.exit(0);
    });

} else {
    console.error("Failed to spawn child");
}
