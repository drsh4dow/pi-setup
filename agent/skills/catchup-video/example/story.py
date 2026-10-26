"""A worked story: three PRs on a CI repo, two calls for the viewer. Render: node video.ts draft story.py"""

from catchup_video import *

CI_OLD = """steps:
  - uses: actions/checkout@v4
  - run: npm ci
  - run: npm test
"""
CI_NEW = """steps:
  - uses: actions/checkout@v4
  - uses: actions/cache@v4
    with: { path: ~/.npm, key: npm-lock }
  - run: npm ci
  - run: npm test
"""


class Story(Video):
    @beat("Three pull requests moved while you were away. Two need a call from you.")
    def intro(self):
        self.graph = Branches({61: "Cache dependency installs", 62: "Retry the artifact upload",
                               63: "Keep logs for 30 days"})
        self.play(self.graph.draw())
        self.at("Two need")
        self.play(self.graph.ring(62), self.graph.ring(63))

    @beat("First, the build cache.", transition=True)
    def cache(self):
        self.dive(self.graph, 61)

    @beat("Every build installed its dependencies from scratch, about fourteen minutes a run.",
          show="Every build installed its dependencies from scratch, about 14 minutes a run.")
    def cache_why(self):
        self.code = Code(CI_OLD, "yaml", path=".github/workflows/build.yml")
        self.show(self.code)
        self.at("about fourteen")
        self.play(self.code.highlight(3))
        self.show(self.code.note(3, "14 min a run", T.RED))

    @beat("The pull request caches them, | and a run now takes three minutes.",
          show="The pull request caches them, | and a run now takes 3 minutes.")
    def cache_win(self):
        self.clear(self.code)
        self.play(self.code.change(CI_NEW))
        self.at("and a run")
        runs = Compare(Number(14, "{:,.0f} min", color=T.RED), Number(3, "{:,.0f} min", color=T.GREEN))
        self.clear(extra=[FadeIn(runs)])
        self.play(runs.reveal())

    @beat("It passes, and Mia approved it.", transition=True)
    def cache_done(self):
        self.play(self.graph.mark(61, "approved"))
        self.pull_back(self.graph)

    @beat("Next, the upload step.", transition=True)
    def upload(self):
        self.dive(self.graph, 62)

    @beat("A release goes from build to upload to publish, and the upload failed one run in twenty.",
          show="A release goes from build to upload to publish, and the upload failed 1 run in 20.")
    def upload_why(self):
        flow = Flow(["build", "upload", "publish"])
        self.play(flow.grow())
        self.at("failed")
        self.play(flow.light(1, T.RED), flow.flag(1, "1 run in 20 times out", icon_kind="cross"))

    @beat("[thoughtful] Earlier I said all twelve checks pass. | Eleven pass, and one is skipped.",
          show="Earlier I said all 12 checks pass. | 11 pass, and 1 is skipped.")
    def upload_checks(self):
        g = Grid(2)
        said = g.put(Correction("all 12 checks pass", "11 pass, 1 skipped"), 0)
        checks = g.put(Tally([("pass", 12, T.GREEN)]), 1)
        self.clear(extra=[FadeIn(said), checks.count()])
        self.at("Eleven")
        self.play(said.strike(), checks.change([("pass", 11, T.GREEN), ("skipped", 1, T.DIM)]))
        self.play(said.fix())

    @beat("Nobody has reviewed it yet.", transition=True)
    def upload_done(self):
        self.play(self.graph.mark(62, "needs review", T.YELLOW, "dot"))
        self.pull_back(self.graph)

    @beat("Last, log retention.", transition=True)
    def logs(self):
        self.dive(self.graph, 63)

    @beat("Keep thirty days, or settle on fourteen? | I would keep thirty.",
          show="Keep 30 days, or settle on 14? | I would keep 30.")
    def logs_call(self):
        pick = Options([("Keep 30 days", ["covers a monthly incident review", "storage grows to 120 GB"]),
                        ("Settle on 14 days", ["half the storage", "misses month-old incidents"])])
        self.show(pick)
        self.at("I would")
        self.play(pick.pick(0))

    @beat("So: merge the cache, review the upload fix, and choose how long to keep logs.", transition=True)
    def outro(self):
        self.play(self.graph.mark(63, "your call", T.YELLOW, "dot"))
        self.pull_back(self.graph)
        self.recap(self.graph, {61: "merge the cache", 62: "review the upload", 63: "choose how long"})
