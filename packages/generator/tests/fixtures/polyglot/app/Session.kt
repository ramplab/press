package fixture

data class Session(val userId: String, val ttlSeconds: Int) {
    fun isExpired(elapsedSeconds: Int): Boolean = elapsedSeconds >= ttlSeconds
}

fun newSession(userId: String): Session = Session(userId, ttlSeconds = 3600)
