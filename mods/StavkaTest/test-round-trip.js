const http = require("http");

let requestCount = 0;

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    requestCount++;
    console.log(`\n=== REQUEST #${requestCount} ===`);
    console.log(`${req.method} ${req.url}`);
    console.log(`Auth: ${req.headers.authorization}`);

    let state = {};
    try {
      state = JSON.parse(body);
    } catch (e) {}

    const groupCount = state.groups ? state.groups.length : 0;
    console.log(`Groups received: ${groupCount}`);

    // Simulate commander response based on request count
    let commands;

    if (requestCount === 1) {
      // First tick: order group 0 to move east
      console.log("> Responding: move_group 0 east");
      commands = {
        tick: state.tick || 0,
        commands: [
          {
            type: "move_group",
            groupId: 0,
            position: [2359, 0, 2047],
            waypointType: "ForcedMove",
          },
        ],
      };
    } else if (requestCount === 2) {
      // Second tick: spawn a new group
      console.log("> Responding: spawn_group");
      commands = {
        tick: state.tick || 0,
        commands: [
          {
            type: "spawn_group",
            prefab:
              "{84E5BBAB25EA23E5}Prefabs/Groups/BLUFOR/Group_US_FireTeam.et",
            position: [2059, 0, 2197],
            faction: "US",
          },
        ],
      };
    } else {
      // Third+: no commands
      console.log("> Responding: no commands");
      commands = {
        tick: state.tick || 0,
        commands: [],
      };
    }

    const responseBody = JSON.stringify(commands);
    console.log(`Response: ${responseBody}`);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(responseBody);
  });
});

server.listen(3000, () => console.log("Stavka test commander on :3000"));
