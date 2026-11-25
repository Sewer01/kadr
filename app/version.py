"""The version of this build. Keep it equal to AppVersion in build/h3studio.iss and to the tag of the GitHub release.

Our own builds number above the version they are taken from: the updater offers a release only when its
number is higher. 2.0.0 is the first release of the independent repository: the program no longer
follows the fork it grew from, and UPDATE_REPO below names the releases it looks at now.
"""

APP_VERSION = "2.2.90"
UPDATE_REPO = "Sewer01/kadr"   # whose releases this program follows
# 2.0.13: the joined film's own copy fades too, and the attempt is written to the log.
