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
UP_OLD = "upload(artifact)\n"
UP_NEW = "retry(upload, artifact, attempts=3)\n"


class Story(Video):
    voice = "Iapetus"

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
        self.code = Code(CI_OLD, "yaml", path=".github/workflows/build.yml").move_to(UP * 0.4)
        self.show(self.code)
        self.at("about fourteen")
        self.play(self.code.highlight(3))

    @beat("The pull request caches them, | and a run now takes three minutes.",
          show="The pull request caches them, | and a run now takes 3 minutes.")
    def cache_win(self):
        self.play(self.code.change(CI_NEW))
        self.at("and a run")
        g = Grid(5)
        shot = g.put(Shot("ci-runs.png", crop=(80, 190, 1120, 510), width=g.size(3)[0]), 2, cs=3)
        bars = g.put(Bars([("before", 14, T.RED), ("after", 3, T.GREEN)], "{:,.0f} min", width=2.6), 0, cs=2)
        self.clear(extra=[FadeIn(shot), FadeIn(bars)])
        self.play(bars.grow(), shot.box(940, 210, 1080, 270, T.GREEN))

    @beat("It passes, and Mia approved it.", transition=True)
    def cache_done(self):
        self.play(self.graph.mark(61, "approved"))
        self.pull_back(self.graph)

    @beat("Next, the upload step.", transition=True)
    def upload(self):
        self.dive(self.graph, 62)

    @beat("It failed about one run in twenty, on a network timeout.",
          show="It failed about 1 run in 20, on a network timeout.")
    def upload_why(self):
        runs = Tiles(20, cols=10, size=0.5, gap=0.14).move_to(UP * 0.6)
        self.show(runs)
        self.at("on a network")
        self.play(runs.tint([13], T.RED))

    @beat("The fix retries it, so three tries in a row must fail: | about one run in eight thousand.",
          show="The fix retries it, so 3 tries in a row must fail: | about 1 run in 8,000.")
    def upload_fix(self):
        code = Code(UP_OLD, "python", path="ci/publish.py").move_to(UP * 2.0)
        self.clear(extra=[FadeIn(code)])
        self.play(code.change(UP_NEW))
        eq = Eq("1/20", colors={"1/20": T.RED}).move_to(DOWN * 0.8)
        self.at("about one run")
        self.show(eq)
        self.play(eq.change("(1/20)³ = 1/8,000", colors={"1/8,000": T.GREEN}))

    @beat("It passes too, but nobody has reviewed it yet.", transition=True)
    def upload_done(self):
        self.play(self.graph.mark(62, "needs review", T.YELLOW, "dot"))
        self.pull_back(self.graph)

    @beat("Last, log retention.", transition=True)
    def logs(self):
        self.dive(self.graph, 63)

    @beat("Logs would stay thirty days instead of seven, | so storage grows from twenty eight gigabytes to one hundred twenty.",
          show="Logs would stay 30 days instead of 7, | so storage grows from 28 GB to 120 GB.")
    def logs_cost(self):
        days = Tiles(7, cols=10, size=0.42, gap=0.12).move_to([-3.4, 1.6, 0])
        self.show(days)
        self.play(days.reflow(30, 10))
        gb = Number(28, "{:,.0f} GB", color=T.BLUE).move_to([3.4, 1.2, 0])
        self.at("so storage")
        self.show(gb)
        self.play(gb.tick(120, color=T.RED))

    @beat("Keep thirty days, or settle on fourteen? | I would keep thirty.",
          show="Keep 30 days, or settle on 14? | I would keep 30.")
    def logs_call(self):
        pick = Options([("Keep 30 days", ["covers a monthly incident review", "120 GB of logs"]),
                        ("Settle on 14 days", ["half the storage", "misses month-old incidents"])]).move_to(UP * 0.3)
        self.clear(extra=[FadeIn(pick)])
        self.at("I would")
        self.play(pick.pick(0))

    @beat("So: merge the cache, review the upload fix, and choose how long to keep logs.", transition=True)
    def outro(self):
        self.play(self.graph.mark(63, "your call", T.YELLOW, "dot"))
        self.pull_back(self.graph)
