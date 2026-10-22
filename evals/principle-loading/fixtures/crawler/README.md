# crawler

`./run-workers.sh` starts 4 workers. Each takes its slice of `urls.txt`, fetches the pages, and records status and title for each URL in `results.json`, which the dashboard reads.
